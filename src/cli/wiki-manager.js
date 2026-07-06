import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManagerEnv } from '../core/env.js';
loadManagerEnv();
import { createAgentGraph } from '../agent/graph.js';
import { handleSlashCommand, printHelp, printVersion, refreshMcpRuntimeStatus } from '../commands/slash.js';
import { runShell } from '../shell/repl.js';
import { runChecks } from '../core/startupCheck.js';
import { applySessionWikircProfile } from '../core/sessionConfig.js';
import { listWikircProfiles } from '../core/wikirc.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { extractActivity, parseJsonText, sessionActivities, terminalFailures } from '../core/activity.js';
import { syncActivitiesToPlan, formatPlanStatus } from '../core/plan.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { runAgentTurn, runAgenticLoop } from '../core/agentLoop.js';
// Runtime modules use node:sqlite (Node.js built-in unavailable in Bun).
// They are imported dynamically so the shell / TUI path never loads them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const SHELL_COMMANDS = ['help', 'version', 'exit', 'workspace', 'new', 'use', 'config', 'status', 'services', 'start', 'stop', 'logs', 'mcp', 'wiki', 'skills', 'clear', 'chat', 'agent', 'approve'];

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function unavailableRuntime(err) {
  const reason = err instanceof Error ? err.message : String(err);
  return { url: null, error: reason };
}

function createSession() {
  return {
    workspace: null,
    workspacePath: null,
    workspaceEnvFile: null,
    wikirc: null,
    wikircConfig: null,
    language: null,
    mcp: null,
    commands: SHELL_COMMANDS,
    chatMode: true,
    llm: null,
    packageJson,
    conversations: { __global__: [] },
    activities: {},
    jobQueue: [],
    productionActivity: null,
    headlessPlan: null,
  };
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function writeHeadlessLog(session, lines, explicitPath) {
  const logPath = explicitPath
    ? resolve(explicitPath)
    : join(session.workspacePath ?? process.cwd(), '.wiki', 'logs', `headless-${timestampForFile()}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
  return logPath;
}


async function runHeadlessActivityLoop(session, log, { wait, timeoutMs }) {
  if (!wait) return { exitCode: 0, completed: [], timedOut: false };
  const deadline = Date.now() + timeoutMs;
  const pollBusy = new Set();
  // Track which keys were non-terminal when we entered, so we can report them on exit.
  const trackedKeys = new Set(sessionActivities(session).filter((a) => !a.terminal).map((a) => a.key));
  log.push(`activity-loop: started, timeout=${Math.round(timeoutMs / 1000)}s`);
  console.log(`[headless] Waiting for active jobs (timeout: ${Math.round(timeoutMs / 1000)}s)…`);

  while (Date.now() < deadline) {
    const candidates = sessionActivities(session).filter((a) => a.poll && !a.terminal);
    if (candidates.length === 0) {
      const completed = sessionActivities(session).filter((a) => trackedKeys.has(a.key));
      const failures = terminalFailures(completed);
      if (failures.length > 0) {
        for (const a of failures) {
          const line = `activity-loop: ${a.label} → ${a.status}${a.error ? ` — ${a.error}` : ''}`;
          log.push(line);
          console.error(`[headless] ${line}`);
        }
        return { exitCode: 1, completed, timedOut: false };
      }
      if (completed.length > 0) {
        log.push('activity-loop: all activities terminal');
        console.log('[headless] All jobs completed.');
      }
      return { exitCode: 0, completed, timedOut: false };
    }

    for (const activity of candidates) {
      const key = activity.key ?? `${activity.poll.server}:${activity.id ?? 'activity'}`;
      if (pollBusy.has(key)) continue;
      const endpoint = session.mcp?.[activity.poll.server];
      if (!endpoint || endpoint.status !== 'connected') {
        const line = `activity-loop: MCP server '${activity.poll.server}' not connected — cannot poll ${key}`;
        log.push(line);
        console.error(`[headless] ${line}`);
        const completed = sessionActivities(session).filter((a) => trackedKeys.has(a.key));
        return { exitCode: 1, completed, timedOut: false };
      }
      const intervalMs = activity.poll.intervalMs ?? 2500;
      if (Date.now() - Date.parse(activity.lastPolledAt ?? '0') < intervalMs) continue;
      pollBusy.add(key);
      activity.lastPolledAt = new Date().toISOString();
      try {
        const result = await callMcpTool(session.mcp, activity.poll.server, activity.poll.tool, activity.poll.args ?? {});
        const payload = parseJsonText(formatMcpToolResult(result));
        const polledActivity = extractActivity(payload, { server: activity.poll.server, tool: activity.poll.tool });
        if (polledActivity) {
          dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
            origin: 'poll',
            payload: { activity: polledActivity },
          }));
        } else {
          syncActivitiesToPlan(session.headlessPlan, sessionActivities(session));
        }
        const updated = sessionActivities(session).find((a) => a.key === key);
        if (updated) {
          const line = `activity-loop: ${updated.label} → ${updated.status}${updated.error ? ` — ${updated.error}` : ''}`;
          log.push(line);
          console.log(`[headless] ${line}`);
        }
      } catch (err) {
        log.push(`activity-loop: poll error ${key} — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        pollBusy.delete(key);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const completed = sessionActivities(session).filter((a) => trackedKeys.has(a.key));
  log.push('activity-loop: timeout');
  console.error('[headless] Timeout waiting for activities to complete.');
  return { exitCode: 1, completed, timedOut: true };
}

async function runHeadlessAgenticLoop(agent, session, initialInput, log, { timeoutMs, maxTurns }) {
  const result = await runAgenticLoop(agent, session, initialInput, {
    timeoutMs,
    maxTurns,
    waitForActivities: async (turnSession, _startedActivities, waitOptions) => {
      const waitResult = await runHeadlessActivityLoop(turnSession, log, { wait: true, timeoutMs: waitOptions.timeoutMs });
      return {
        ok: waitResult.exitCode === 0 && !waitResult.timedOut,
        ...waitResult,
      };
    },
    onTurnStart: ({ turn, maxTurns: totalTurns }) => {
      log.push(`agentic-loop: turn ${turn}/${totalTurns}`);
      console.log(`[headless] Agent turn ${turn}/${totalTurns}…`);
    },
    onTurnResponse: ({ turn, response }) => {
      log.push(`agentic-loop: turn ${turn} response:`);
      log.push(response);
      console.log(response);
    },
    onPlanExtracted: ({ steps }) => {
      log.push(`agentic-loop: plan extracted from text (${steps.length} steps, deprecated fallback)`);
    },
    onPlanAlreadySet: ({ steps }) => {
      log.push(`agentic-loop: plan set via tool (${steps.length} steps)`);
    },
    onComplete: () => {
      log.push('agentic-loop: no new non-terminal activities — plan complete');
      console.log('[headless] Plan complete.');
    },
    onPendingSteps: ({ pendingSteps }) => {
      log.push(`agentic-loop: no new async activity, ${pendingSteps.length} pending step(s) remain`);
      if (session.headlessPlan) log.push(`agentic-loop: plan status:\n${formatPlanStatus(session.headlessPlan)}`);
    },
    onActivitiesStarted: ({ activities }) => {
      log.push(`agentic-loop: ${activities.length} new job(s) started, waiting…`);
    },
    onActivitiesCompleted: ({ summary }) => {
      log.push(`agentic-loop: completed activities:\n${summary}`);
      if (session.headlessPlan) log.push(`agentic-loop: plan status:\n${formatPlanStatus(session.headlessPlan)}`);
    },
    onMaxTurns: ({ maxTurns: totalTurns }) => {
      log.push(`agentic-loop: max turns (${totalTurns}) reached without completing`);
      console.error(`[headless] Max agent turns (${totalTurns}) reached.`);
    },
  });

  return { exitCode: result.ok ? 0 : (result.waitResult?.exitCode ?? 1) };
}

async function runHeadless(argv, agent) {
  const workspaceName = valueAfter(argv, '--workspace');
  const skillName = valueAfter(argv, '--skill');
  const prompt = valueAfter(argv, '--prompt');
  const logFile = valueAfter(argv, '--log-file');
  const timeoutArg = valueAfter(argv, '--timeout');
  const maxTurnsArg = valueAfter(argv, '--max-turns');
  const timeoutMs = (Number.isFinite(Number(timeoutArg)) ? Math.max(1, Number(timeoutArg)) : 3600) * 1000;
  const maxTurns = Number.isFinite(Number(maxTurnsArg)) ? Math.max(1, Number(maxTurnsArg)) : 20;
  // --skill uses the agentic loop (multi-turn); --prompt uses a single turn unless --wait is set.
  const useAgenticLoop = Boolean(skillName) && !argv.includes('--no-wait');
  const wait = !useAgenticLoop && (argv.includes('--wait'));
  const log = [`wiki-manager ${packageJson.version} headless`, `startedAt=${new Date().toISOString()}`];

  if (!workspaceName) throw new Error('Usage: wiki-manager --headless --workspace <name> (--skill <name>|--prompt <text>)');
  if (!skillName && !prompt) throw new Error('Usage: wiki-manager --headless --workspace <name> (--skill <name>|--prompt <text>)');

  const session = createSession();
  session.headless = true;
  session.chatMode = false;
  const step = (line) => {
    log.push(line);
    console.log(line);
  };

  try {
    const useResult = await handleSlashCommand(`/use ${workspaceName}`, { packageJson, session, onStep: step });
    if (useResult.output) log.push(useResult.output);
    if (!session.workspacePath) throw new Error(useResult.output || `Workspace not loaded: ${workspaceName}`);
    if (!session.llm) throw new Error(`Workspace ${workspaceName} has no usable LLM config.`);

    let input = prompt;
    if (skillName) {
      const skillResult = await handleSlashCommand(`/skills run ${skillName}`, { packageJson, session, onStep: step });
      if (skillResult.output) log.push(skillResult.output);
      if (String(skillResult.output ?? '').startsWith('Skill not found')) throw new Error(`Skill not found: ${skillName}`);
      input = skillResult.agentTrigger
        ? [
            skillResult.agentTrigger,
            prompt ? `Additional instruction: ${prompt}` : null,
          ].filter(Boolean).join('\n\n')
        : [
            `Run the ${skillName} skill for workspace ${workspaceName} in headless mode.`,
            prompt ? `Additional instruction: ${prompt}` : null,
            '',
            skillResult.output,
          ].filter(Boolean).join('\n');
    }

    log.push(`input=${input}`);
    dispatchAgentEvent(session, createAgentEvent('run_started', {
      origin: 'user',
      payload: { input },
    }));
    dispatchAgentEvent(session, createAgentEvent('user_message', {
      origin: 'user',
      payload: { content: input },
    }));
    let exitCode = 0;
    if (useAgenticLoop) {
      ({ exitCode } = await runHeadlessAgenticLoop(agent, session, input, log, { timeoutMs, maxTurns }));
    } else {
      const response = await runAgentTurn(agent, session, input);
      log.push('response:');
      log.push(response);
      console.log(response);
      ({ exitCode } = await runHeadlessActivityLoop(session, log, { wait, timeoutMs }));
    }
    const saved = await writeHeadlessLog(session, log, logFile);
    console.log(`Headless log: ${saved}`);
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (err) {
    log.push(`error=${err instanceof Error ? err.message : String(err)}`);
    if (session.workspacePath || logFile) {
      const saved = await writeHeadlessLog(session, log, logFile);
      console.error(`Headless log: ${saved}`);
    }
    throw err;
  }
}

async function runRuntime(argv, agent) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'Usage: wiki-manager runtime [--host <host>] [--port <port>] [--state-dir <dir>]',
      '',
      'Runs the local agentic runtime used by wiki-manager Shell and llm-wiki serve.',
      '',
      'Defaults:',
      '  --host 127.0.0.1',
      '  --port 7788',
      '  --state-dir .wiki-manager',
    ].join('\n'));
    return;
  }
  const { defaultRuntimeStateDir, openRuntimeStore, RECOVERABLE_QUEUE_STATUSES } = await import('../runtime/store.js');
  const { startRuntimeServer } = await import('../runtime/server.js');
  const { emitRuntimeLog, startActivitySupervisor } = await import('../runtime/supervisor.js');
  const { resolveRuntimeAuthToken } = await import('../runtime/auth.js');
  const { createSqliteQueueStore } = await import('../runtime/queueStore.js');
  const { createApprovalManager } = await import('../runtime/approvals.js');
  const { runRuntimeAgenticWorkflow } = await import('../runtime/runner.js');

  const host = valueAfter(argv, '--host') ?? process.env.WIKI_MANAGER_RUNTIME_HOST ?? '127.0.0.1';
  const port = Number(valueAfter(argv, '--port') ?? process.env.WIKI_MANAGER_RUNTIME_PORT ?? 7788);
  const stateDir = valueAfter(argv, '--state-dir') ?? defaultRuntimeStateDir();
  const auth = resolveRuntimeAuthToken({ host, stateDir });
  if (auth.token) process.env.WIKI_MANAGER_RUNTIME_TOKEN = auth.token;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid runtime port: ${port}`);
  }

  const store = openRuntimeStore({ stateDir });
  let serverHandle = null;
  const contexts = new Map();

  async function getWorkspaceContext(workspaceName = null) {
    const requestedWorkspace = workspaceName ? String(workspaceName).trim() : null;
    const key = requestedWorkspace ?? '__default__';
    if (contexts.has(key)) return contexts.get(key);

    const pending = (async () => {
      const session = createSession();
      session.headless = true;
      session.chatMode = false;
      session.packageJson = packageJson;

      if (requestedWorkspace) {
        const result = await handleSlashCommand(`/use ${requestedWorkspace}`, { packageJson, session });
        if (!session.workspacePath) throw new Error(result.output || `Workspace not loaded: ${requestedWorkspace}`);
      }
      const workspace = session.workspace ?? requestedWorkspace ?? null;
      store.hydrateSession(session, { workspace });
      session.queueStore = createSqliteQueueStore(store, session, { workspace });

      const context = {
        workspace,
        session,
        supervisor: null,
        running: false,
        currentAbortController: null,
        approvalManager: null,
      };
      session._onAgentEvent = (event) => {
        store.persistEvent(event);
        serverHandle?.publish(event);
      };
      session._onRuntimeError = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        dispatchAgentEvent(session, createAgentEvent('run_error', {
          origin: 'runtime',
          payload: { message, workspace },
        }));
      };
      context.approvalManager = createApprovalManager(session, {
        defaultTimeoutMs: Number.isFinite(Number(process.env.WIKI_MANAGER_APPROVAL_TIMEOUT_MS))
          ? Math.max(1, Number(process.env.WIKI_MANAGER_APPROVAL_TIMEOUT_MS))
          : undefined,
      });
      session._requestApproval = (request) => context.approvalManager.requestApproval(request);
      context.supervisor = startActivitySupervisor(session);
      contexts.set(key, context);
      if (workspace && workspace !== key) contexts.set(workspace, context);
      return context;
    })();
    contexts.set(key, pending);
    pending.catch(() => {
      if (contexts.get(key) === pending) contexts.delete(key);
    });
    return pending;
  }

  function recoveryMcpGaps(context) {
    const gaps = [];
    const session = context.session;
    for (const activity of sessionActivities(session)) {
      if (activity.terminal || !activity.poll?.server) continue;
      const endpoint = session.mcp?.[activity.poll.server];
      if (endpoint?.status !== 'connected') gaps.push(activity.poll.server);
    }
    for (const item of session.queueStore?.list?.() ?? []) {
      const status = String(item.status ?? '').toLowerCase();
      if (!RECOVERABLE_QUEUE_STATUSES.includes(status)) continue;
      const endpoint = session.mcp?.[item.server ?? 'production'];
      if (endpoint?.status !== 'connected') gaps.push(item.server ?? 'production');
    }
    return [...new Set(gaps)];
  }

  function activeNonTerminalActivities(session) {
    return sessionActivities(session).filter((activity) => !activity.terminal);
  }

  function activePollingActivities(session) {
    return activeNonTerminalActivities(session).filter((activity) => activity.poll);
  }

  function buildRecoveryPrompt(run, session) {
    const conversation = session.agentProjection?.conversation ?? [];
    const recentConversation = conversation
      .slice(-8)
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');
    return [
      'Resume an interrupted runtime run.',
      '',
      'Original task:',
      run.input ?? '(unknown)',
      '',
      session.headlessPlan ? `Current plan:\n${formatPlanStatus(session.headlessPlan)}` : null,
      recentConversation ? `Recent conversation:\n${recentConversation}` : null,
      '',
      'Continue from the current plan state. Start only the next pending step.',
      'If the work is already complete, provide a concise final summary.',
    ].filter(Boolean).join('\n');
  }

  function startRecoveredAgenticRun(context, run) {
    if (context.running) return false;
    const session = context.session;
    const supervisor = context.supervisor;
    const runId = run.id;
    const input = buildRecoveryPrompt(run, session);
    context.running = true;
    context.currentAbortController = new AbortController();
    session._currentRunIdentity = {
      runId,
      turnId: `${runId}:resume-0`,
      workspace: context.workspace,
    };
    session._abortSignal = context.currentAbortController.signal;
    supervisor?.setRunSignal(context.currentAbortController.signal);
    session._onStep = (message) => emitRuntimeLog(session, message);
    emitRuntimeLog(session, `runtime: resuming interrupted run ${runId}`);

    runRuntimeAgenticWorkflow(agent, session, run.input ?? input, {
      initialInput: input,
      signal: context.currentAbortController.signal,
      timeoutMs: 3600 * 1000,
      maxTurns: 20,
      runId,
      pollBusy: supervisor?.pollBusy,
    })
      .catch((err) => {
        if (err?.name === 'AbortError') {
          dispatchAgentEvent(session, createAgentEvent('run_cancelled', {
            origin: 'runtime',
            runId,
            payload: { runId, message: 'Recovered runtime run cancelled.' },
          }));
          return;
        }
        dispatchAgentEvent(session, createAgentEvent('run_error', {
          origin: 'runtime',
          runId,
          payload: {
            runId,
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      })
      .finally(() => {
        context.running = false;
        context.currentAbortController = null;
        supervisor?.setRunSignal(null);
        delete session._abortSignal;
        delete session._onStep;
        delete session._currentRunIdentity;
      });

    return true;
  }

  async function recoverWorkspace(workspace, { manual = false } = {}) {
    try {
      const context = await getWorkspaceContext(workspace);
      await refreshMcpRuntimeStatus(context.session);
      const gaps = recoveryMcpGaps(context);
      if (gaps.length > 0) {
        const interrupted = store.interruptRuns({ workspace: context.workspace });
        return {
          workspace: context.workspace ?? workspace ?? null,
          resumed: false,
          interrupted,
          reason: `MCP unavailable: ${gaps.join(', ')}`,
        };
      }
      const recoverableRuns = store.listRecoverableRuns({ workspace: context.workspace });
      const runningRun = recoverableRuns.find((run) => run.status === 'running');
      const activeActivities = activeNonTerminalActivities(context.session);
      const pollingActivities = activePollingActivities(context.session);
      if (runningRun && activeActivities.length === 0) {
        if (!runningRun.input) {
          const interrupted = store.interruptRuns({ workspace: context.workspace });
          return {
            workspace: context.workspace ?? workspace ?? null,
            resumed: false,
            interrupted,
            reason: 'Missing original run input.',
          };
        }
        const started = startRecoveredAgenticRun(context, runningRun);
        return {
          workspace: context.workspace ?? workspace ?? null,
          resumed: started,
          interrupted: 0,
          mode: 'agentic_loop',
        };
      }
      if (runningRun && runningRun.input && pollingActivities.length > 0) {
        context.session._onActivitiesTerminal = () => {
          startRecoveredAgenticRun(context, runningRun);
        };
        emitRuntimeLog(context.session, `runtime: recovery watching ${pollingActivities.length} active activity(s)`);
        return {
          workspace: context.workspace ?? workspace ?? null,
          resumed: true,
          interrupted: 0,
          mode: 'activity_poll_then_resume',
        };
      }
      emitRuntimeLog(context.session, manual ? 'runtime: manual resume completed' : 'runtime: recovery completed');
      const controlStarted = pollingActivities.length === 0
        ? serverHandle?.drainControl?.(context) === true
        : false;
      return {
        workspace: context.workspace ?? workspace ?? null,
        resumed: true,
        interrupted: 0,
        mode: controlStarted ? 'control_queue' : pollingActivities.length > 0 ? 'activity_poll' : 'context',
      };
    } catch (err) {
      const interrupted = store.interruptRuns({ workspace });
      return {
        workspace: workspace ?? null,
        resumed: false,
        interrupted,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function recoverRuntime({ workspace = null, manual = false } = {}) {
    const workspaces = workspace ? [workspace] : store.listRecoverableWorkspaces();
    const results = await Promise.all(workspaces.map((item) => recoverWorkspace(item, { manual })));
    return {
      resumed: results.filter((result) => result.resumed).length,
      interrupted: results.reduce((sum, result) => sum + Number(result.interrupted ?? 0), 0),
      workspaces: results,
    };
  }

  async function executeRun(context, body, { signal } = {}) {
    const session = context.session;
    const supervisor = context.supervisor;
    const input = String(body.input ?? body.prompt ?? '').trim();
    const workspace = body.workspace ? String(body.workspace).trim() : null;
    const timeoutMs = (Number.isFinite(Number(body.timeout)) ? Math.max(1, Number(body.timeout)) : 3600) * 1000;
    const maxTurns = Number.isFinite(Number(body.maxTurns)) ? Math.max(1, Number(body.maxTurns)) : 20;
    const maxReplans = Number.isFinite(Number(body.replans)) ? Math.max(0, Math.floor(Number(body.replans))) : undefined;
    const runId = String(body.runId);
    try {
      if (workspace && session.workspace !== workspace) {
        const result = await handleSlashCommand(`/use ${workspace}`, { packageJson, session });
        if (!session.workspacePath) throw new Error(result.output || `Workspace not loaded: ${workspace}`);
      }
      context.workspace = session.workspace ?? workspace ?? context.workspace ?? null;
      session._currentRunIdentity = {
        runId,
        turnId: `${runId}:turn-0`,
        workspace: context.workspace,
      };
      dispatchAgentEvent(session, createAgentEvent('run_started', {
        origin: 'runtime',
        runId,
        payload: { input, workspace: session._currentRunIdentity.workspace },
      }));
      dispatchAgentEvent(session, createAgentEvent('user_message', {
        origin: 'user',
        runId,
        payload: { content: input },
      }));
      session._abortSignal = signal ?? null;
      session._runApprovalRequired = body.requireApproval === true;
      session._runApprovalResolved = false;
      session._approvalTimeoutMs = Number.isFinite(Number(body.approvalTimeoutMs))
        ? Math.max(1, Number(body.approvalTimeoutMs))
        : undefined;
      supervisor?.setRunSignal(signal);
      session._onStep = (message) => emitRuntimeLog(session, message);
      await runRuntimeAgenticWorkflow(agent, session, input, {
        signal,
        timeoutMs,
        maxTurns,
        runId,
        pollBusy: supervisor?.pollBusy,
        evaluate: body.evaluate !== false,
        ...(maxReplans === undefined ? {} : { maxReplans }),
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        dispatchAgentEvent(session, createAgentEvent('run_cancelled', {
          origin: 'runtime',
          runId,
          payload: {
            runId,
            message: 'Agent run cancelled.',
          },
        }));
        return;
      }
      dispatchAgentEvent(session, createAgentEvent('run_error', {
        origin: 'runtime',
        runId,
        payload: {
          runId,
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      supervisor?.setRunSignal(null);
      delete session._abortSignal;
      delete session._onStep;
      delete session._currentRunIdentity;
      delete session._runApprovalRequired;
      delete session._runApprovalResolved;
      delete session._approvalTimeoutMs;
    }
  }

  serverHandle = await startRuntimeServer({
    host,
    port,
    store,
    getContext: getWorkspaceContext,
    run: executeRun,
    cancel: (context) => emitRuntimeLog(context.session, 'runtime: cancel requested'),
    resume: ({ workspace }) => recoverRuntime({ workspace, manual: true }),
    approve: async ({ workspace, runId, itemId, approvalId }) => {
      const context = await getWorkspaceContext(workspace);
      return context.approvalManager?.approve({ runId, itemId, approvalId }) ?? { approved: false };
    },
    configProfiles: async (context) => {
      const profiles = listWikircProfiles(context.session.workspacePath);
      return {
        profiles: profiles.map((profile) => profile.name),
        active: context.session.wikirc?.profile ?? null,
        items: profiles.map((profile) => ({
          name: profile.name,
          fileName: profile.fileName,
          default: Boolean(profile.default),
        })),
      };
    },
    useConfigProfile: async (context, profile) => {
      const { summary, config } = applySessionWikircProfile(context.session, profile);
      await refreshMcpRuntimeStatus(context.session);
      dispatchAgentEvent(context.session, createAgentEvent('runtime_log', {
        origin: 'runtime',
        payload: { message: `runtime: config profile switched to ${context.session.wikirc?.profile ?? profile}` },
      }));
      return {
        ok: true,
        active: context.session.wikirc?.profile ?? profile,
        fileName: context.session.wikirc?.fileName ?? null,
        summary,
        config,
      };
    },
    token: auth.token,
  });
  const recovery = await recoverRuntime();

  console.log(`wiki-manager runtime listening on http://${host}:${port}`);
  console.log(`runtime state: ${store.dbPath}`);
  if (recovery.resumed > 0 || recovery.interrupted > 0) {
    console.log(`runtime recovery: resumed=${recovery.resumed} interrupted=${recovery.interrupted}`);
  }
  if (auth.tokenPath) console.log(`runtime token: ${auth.tokenPath}`);

  const shutdown = async () => {
    await Promise.all([...new Set(contexts.values())].map(async (v) => { (await v).supervisor?.stop(); }));
    await serverHandle.close();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise(() => {});
}

export async function runCli(argv) {
  if (argv[0] === 'runtime') {
    const agent = createAgentGraph();
    await runRuntime(argv.slice(1), agent);
    return;
  }

  if (argv.includes('--setup-wizard')) {
    if (!process.versions.bun) {
      throw new Error('Setup wizard requires Bun. Run: bun ./bin/wiki-manager.js --setup-wizard');
    }
    const { runSetupWizard } = await import('../shell/tui.tsx');
    await runSetupWizard({
      workspaceName: valueAfter(argv, '--workspace-name'),
      workspacePath: valueAfter(argv, '--workspace-path') ?? null,
    });
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    printVersion(packageJson);
    return;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(packageJson);
    return;
  }

  const agent = createAgentGraph();
  if (argv.includes('--headless')) {
    try {
      await runHeadless(argv, agent);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  const once = valueAfter(argv, '--once');
  if (once) {
    const result = await agent.invoke({
      input: once,
      session: createSession(),
    });
    console.log(result.response);
    return;
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    if (!process.versions.bun) {
      throw new Error('Interactive TUI requires Bun. Run: bun ./bin/wiki-manager.js');
    }
    const { runOpenTuiShell, runStartupWizard } = await import('../shell/tui.tsx');
    const gaps = await runChecks();
    if (gaps.length > 0) await runStartupWizard(gaps);
    let runtime = null;
    try {
      const { ensureRuntime } = await import('../runtime/lifecycle.js');
      runtime = await ensureRuntime();
    } catch (err) {
      runtime = unavailableRuntime(err);
      console.error(`Runtime unavailable: ${runtime.error}`);
    }
    await runOpenTuiShell({ agent, packageJson, runtime });
    return;
  }

  let runtime = null;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const { ensureRuntime } = await import('../runtime/lifecycle.js');
      runtime = await ensureRuntime();
    } catch (err) {
      runtime = unavailableRuntime(err);
      console.error(`Runtime unavailable: ${runtime.error}`);
    }
  }
  await runShell({ agent, packageJson, runtime });
}
