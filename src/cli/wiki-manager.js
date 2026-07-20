import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureManagerScaffold, loadManagerEnv } from '../core/env.js';
loadManagerEnv();
import { createAgentGraph } from '../agent/graph.js';
import { handleSlashCommand, printHelp, printVersion, refreshMcpRuntimeStatus } from '../commands/slash.js';
import { runShell, runHeadlessChatTurn } from '../shell/repl.js';
import { runPreflightChecks, withRuntimePreflight } from '../core/startupCheck.js';
import { applySessionWikircProfile } from '../core/sessionConfig.js';
import { listWikircProfiles } from '../core/wikirc.js';
import { callMcpTool, formatMcpToolResult, readChatAccessConfig } from '../core/mcp.js';
import { extractActivity, parseJsonText, sessionActivities, terminalFailures } from '../core/activity.js';
import { syncActivitiesToPlan, formatPlanStatus } from '../core/plan.js';
import { createAgentEvent, dispatchAgentEvent, reduceAgentEvents } from '../core/agentEvents.js';
import { runAgentTurn, runAgenticLoop } from '../core/agentLoop.js';
import { resolveCapabilityConcurrency } from '../orchestrator/scheduler.js';
import { capabilityRegistryForSession } from '../orchestrator/capabilityRegistry.js';
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

function errorDiagnostic(err) {
  const parts = [];
  let current = err;
  const seen = new Set();
  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    const name = current?.name && current.name !== 'Error' ? String(current.name) : '';
    const code = current?.code ? String(current.code) : '';
    const message = current instanceof Error ? current.message : String(current);
    const detail = [name, code, message].filter(Boolean).join(' ');
    if (detail && !parts.includes(detail)) parts.push(detail);
    current = current?.cause;
  }
  return parts.join(' <- ') || 'unknown error';
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

export function createInteractiveSession(context, { runtimeUrl, turnId, signal = null } = {}) {
  const source = context.session;
  const session = createSession();
  for (const key of [
    'workspace', 'workspacePath', 'workspaceEnvFile', 'workspaceEnv',
    'wikirc', 'wikircConfig', 'language', 'llm', 'mcp', 'commands',
    'packageJson', 'queueStore', 'systemPrompt',
  ]) {
    if (source[key] !== undefined) session[key] = source[key];
  }
  session.runtime = runtimeUrl ? { url: runtimeUrl } : null;
  session.headless = true;
  session.chatMode = false;
  session.chatAccess = null;
  session.conversations = { [session.workspace || '__global__']: [] };
  session.agentEvents = [];
  session.activities = {};
  session.productionActivity = null;
  session.jobQueue = [];
  session.headlessPlan = null;
  session.turnId = turnId ?? null;
  session._abortSignal = signal;
  return session;
}

export function ensureInteractiveAssistantMessage(session, response, { turnId, workspace } = {}) {
  const content = String(response ?? '').trim();
  if (!content || session.agentEvents.some((event) => event.type === 'assistant_message')) return false;
  dispatchAgentEvent(session, createAgentEvent('assistant_message', {
    origin: 'runtime_turn', turnId, workspace, payload: { content: String(response) },
  }));
  return true;
}

export async function forwardRuntimeApproval(getWorkspaceContext, request = {}) {
  const context = await getWorkspaceContext(request.workspace ?? null);
  return context.approvalManager?.approve(request) ?? { approved: false };
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

// Observe a runtime-delegated run from headless: the run executes server-side,
// so poll /state and mirror status transitions, new logs and the final plan
// into the headless log until the run reaches a terminal state.
async function waitForRuntimeRun(session, log, { timeoutMs, pollMs = 1500, autoApprove = false, priorRunIds = [] } = {}) {
  const { fetchRuntimeState, postRuntimeApprove } = await import('../runtime/client.js');
  const url = session.runtime?.url;
  const workspace = session.workspace ?? null;
  if (!url) return { exitCode: 0 };
  // Scope strictly to the run this turn created: any run already present before
  // the turn (including a stuck/zombie run) must be ignored, or the wait would
  // observe/approve the wrong run and never finish.
  const priorSet = new Set((priorRunIds ?? []).map(String));
  const terminal = new Set(['succeeded', 'success', 'done', 'complete', 'completed', 'failed', 'error', 'cancelled', 'canceled']);
  const deadline = Date.now() + timeoutMs;
  const graceDeadline = Date.now() + 8000;
  let lastStatus = null;
  let lastLogCount = 0;
  let sawRun = false;
  const approvedRevisions = new Set();
  while (Date.now() < deadline) {
    let state;
    try {
      state = await fetchRuntimeState({ url, workspace });
    } catch (err) {
      const line = `runtime-wait: state fetch failed (${err instanceof Error ? err.message : String(err)})`;
      log.push(line); console.error(line);
      return { exitCode: 1 };
    }
    const logs = Array.isArray(state?.logs) ? state.logs : [];
    for (const entry of logs.slice(lastLogCount)) {
      const text = typeof entry === 'string' ? entry : String(entry?.message ?? JSON.stringify(entry));
      log.push(`runtime: ${text}`); console.log(`[runtime] ${text}`);
    }
    lastLogCount = logs.length;
    const runs = Array.isArray(state?.runs) ? state.runs : [];
    const currentRun = runs.find((run) => run?.id && !priorSet.has(String(run.id)));
    if (!currentRun) {
      if (sawRun) return { exitCode: 0 };
      if (Date.now() >= graceDeadline) {
        const line = 'runtime-wait: no run was delegated this turn (Donna answered without starting a run).';
        log.push(line); console.log(line);
        return { exitCode: 0 };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    sawRun = true;
    const status = String(currentRun.status ?? 'running').toLowerCase();
    if (status !== lastStatus) {
      log.push(`runtime-status: ${status} (run ${currentRun.id})`); console.log(`[runtime] status=${status}`);
      lastStatus = status;
    }
    // Approval is granted per task, so the run status stays "running" while a
    // task waits — detect the block via state.approvals, scoped to this run.
    const pendingApprovals = (Array.isArray(state?.approvals) ? state.approvals : [])
      .filter((approval) => approval.status === 'pending_approval'
        && (approval.runId == null || String(approval.runId) === String(currentRun.id)));
    if (pendingApprovals.length > 0) {
      if (!autoApprove) {
        const line = `runtime-wait: run ${currentRun.id} waiting for approval (${pendingApprovals.length} task(s)); re-run with --auto-approve to drive it through.`;
        log.push(line); console.log(line);
        return { exitCode: 0 };
      }
      const planRevision = state?.planRevision ?? currentRun.planRevision ?? 0;
      if (!approvedRevisions.has(planRevision)) {
        approvedRevisions.add(planRevision);
        const approvalClasses = [...new Set(pendingApprovals.flatMap((approval) => {
          const value = approval.approvalClasses ?? approval.approvalClass ?? [];
          return Array.isArray(value) ? value : [value];
        }).map(String).filter(Boolean))];
        try {
          const result = await postRuntimeApprove({
            url,
            workspace,
            runId: currentRun.id,
            scope: 'run',
            planRevision,
            approvalClasses: approvalClasses.length > 0 ? approvalClasses : ['default'],
          });
          const line = `runtime-wait: auto-approved run ${currentRun.id} (revision ${planRevision})${result?.approved ? '' : ' [no pending approval matched]'}`;
          log.push(line); console.log(line);
        } catch (err) {
          const line = `runtime-wait: auto-approve failed (${err instanceof Error ? err.message : String(err)})`;
          log.push(line); console.error(line);
          return { exitCode: 1 };
        }
      }
    }
    if (terminal.has(status)) {
      const plan = Array.isArray(currentRun.plan) ? currentRun.plan
        : (Array.isArray(state?.plan) ? state.plan : []);
      if (plan.length > 0) {
        log.push(`runtime-plan:\n${plan.map((planStep) => `  - ${planStep.description ?? planStep.id ?? planStep.step ?? ''}: ${planStep.status ?? ''}`).join('\n')}`);
      }
      return { exitCode: status === 'failed' || status === 'error' ? 1 : 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const line = 'runtime-wait: timeout waiting for the delegated run to finish.';
  log.push(line); console.error(line);
  return { exitCode: 1 };
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

    // Agent-mode parity: the interactive TUI runs every turn against the
    // runtime (delegation + run control) with MCP connected. Without a
    // runtime, the graph exposes no runtime__delegate tool, so any action
    // request degrades to a chat-like text answer instead of a real delegated
    // run — which is exactly why headless "looked like chat mode". Connect the
    // same way the TUI does. Use --no-runtime for the legacy direct-MCP path.
    if (!argv.includes('--no-runtime')) {
      try {
        const { ensureRuntime } = await import('../runtime/lifecycle.js');
        const runtime = await ensureRuntime();
        session.runtime = runtime?.url ? { url: runtime.url, started: Boolean(runtime.started) } : null;
        step(`runtime: ${session.runtime ? `connected ${session.runtime.url}` : 'unavailable'}`);
      } catch (err) {
        session.runtime = null;
        step(`runtime: unavailable (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    await refreshMcpRuntimeStatus(session);
    step(`mcp: ${Object.values(session.mcp ?? {}).filter((value) => value.status === 'connected').length} connected`);
    // Surface which tools Donna is actually offered this turn: if a factual
    // question is answered without the matching read tool appearing here, the
    // problem is discovery/connection, not the model.
    for (const [name, value] of Object.entries(session.mcp ?? {})) {
      if (value?.status !== 'connected') continue;
      const toolNames = (value.tools ?? []).map((tool) => tool.name).join(', ');
      step(`mcp-tools ${name}: ${toolNames || '(none discovered)'}`);
    }
    // Wire the graph's step trace (classification, tool calls, retries) into
    // the headless log so the agent-mode decision is observable.
    session._onStep = step;

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
      // Snapshot existing runs so the wait scopes strictly to the run this turn
      // creates and never observes a pre-existing / zombie run.
      let priorRunIds = [];
      if (session.runtime?.url && wait) {
        try {
          const { fetchRuntimeState } = await import('../runtime/client.js');
          const before = await fetchRuntimeState({ url: session.runtime.url, workspace: session.workspace ?? null });
          priorRunIds = (Array.isArray(before?.runs) ? before.runs : []).map((run) => run?.id).filter(Boolean);
        } catch { priorRunIds = []; }
      }
      const response = await runAgentTurn(agent, session, input);
      log.push('response:');
      log.push(response);
      console.log(response);
      // When connected to the runtime, an action turn delegates a run that
      // executes server-side — its progress lives in runtime state, not in the
      // local session. Poll it so the headless log shows the real outcome.
      ({ exitCode } = session.runtime?.url && wait
        ? await waitForRuntimeRun(session, log, { timeoutMs, autoApprove: argv.includes('--auto-approve'), priorRunIds })
        : await runHeadlessActivityLoop(session, log, { wait, timeoutMs }));
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
      '  --state-dir .wiki/runtime',
    ].join('\n'));
    return;
  }
  const { defaultRuntimeStateDir, openRuntimeStore, RECOVERABLE_QUEUE_STATUSES } = await import('../runtime/store.js');
  const { startRuntimeServer } = await import('../runtime/server.js');
  const { recoverActiveRuns } = await import('../runtime/recoveryManager.js');
  const { emitRuntimeLog, startActivitySupervisor, cancelActiveActivityJobs } = await import('../runtime/supervisor.js');
  const { resolveRuntimeAuthToken } = await import('../runtime/auth.js');
  const { createSqliteQueueStore } = await import('../runtime/queueStore.js');
  const { createApprovalManager } = await import('../runtime/approvals.js');
  const { conversationSeed, runRuntimeAgenticWorkflow } = await import('../runtime/runner.js');

  const host = valueAfter(argv, '--host') ?? process.env.WIKI_MANAGER_RUNTIME_HOST ?? '127.0.0.1';
  const port = Number(valueAfter(argv, '--port') ?? process.env.WIKI_MANAGER_RUNTIME_PORT ?? 7788);
  const stateDir = valueAfter(argv, '--state-dir') ?? defaultRuntimeStateDir();
  const auth = resolveRuntimeAuthToken({ host, stateDir });
  if (auth.token) process.env.WIKI_MANAGER_RUNTIME_TOKEN = auth.token;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid runtime port: ${port}`);
  }
  const selfRuntimeUrl = process.env.WIKI_MANAGER_RUNTIME_URL
    ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

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
      session.runtime = { url: selfRuntimeUrl };

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
      // Control requests queued in a PREVIOUS runtime process must not
      // auto-run at boot: a "stop le job" typed last night starting hours
      // later as a fresh run violates least surprise. Expire them — the
      // user can always resubmit.
      const staleControl = (session.controlQueue ?? []).filter((item) => item.status === 'queued');
      for (const item of staleControl) {
        dispatchAgentEvent(session, createAgentEvent('control_cancelled', {
          origin: 'runtime',
          workspace,
          payload: { id: item.id, reason: 'stale_at_boot' },
        }));
      }
      if (staleControl.length > 0) {
        dispatchAgentEvent(session, createAgentEvent('runtime_log', {
          origin: 'runtime',
          workspace,
          payload: { message: `runtime: expired ${staleControl.length} stale queued control request(s) from a previous session` },
        }));
      }
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
      const taskRecovery = await recoverActiveRuns({
        store,
        session: context.session,
        workspace: context.workspace,
        callTool: callMcpTool,
      });
      if (!taskRecovery.ok) {
        const interrupted = store.interruptRuns({ workspace: context.workspace });
        return {
          workspace: context.workspace ?? workspace ?? null,
          resumed: false,
          interrupted,
          reason: `Task recovery failed: ${taskRecovery.errors.map((item) => `${item.taskId}: ${item.error}`).join('; ')}`,
        };
      }
      if (taskRecovery.recovered.length > 0 || taskRecovery.rescheduled.length > 0) {
        emitRuntimeLog(
          context.session,
          `runtime: recovery attached ${taskRecovery.recovered.length} job(s), requeued ${taskRecovery.rescheduled.length} task(s)`,
        );
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

  async function prepareDelegation(context, { objective }) {
    const { resolveObjective } = await import('../orchestrator/objectiveResolver.js');
    const { validateFragment } = await import('../orchestrator/planValidator.js');
    const session = context.session;
    let selection;
    try {
      selection = await resolveObjective(objective, session);
    } catch (err) {
      throw new Error(`Delegation failed during objective_resolution: ${errorDiagnostic(err)}`, { cause: err });
    }
    const provider = selection.provider;
    let planResult;
    try {
      planResult = await callMcpTool(
        session.mcp,
        provider.serverName,
        'agent_plan',
        {
          capability: selection.capability,
          operation: selection.operation,
          objective,
          workspace: { revision: String(Date.now()) },
          constraints: {
            maxConcurrency: resolveCapabilityConcurrency(
              provider,
              undefined,
              process.env.WIKI_MANAGER_CAPABILITY_CONCURRENCY,
            ),
            requireApprovalForMutations: true,
          },
        },
      );
    } catch (err) {
      const endpoint = session.mcp?.[provider.serverName]?.url ?? 'unknown endpoint';
      throw new Error(
        `Delegation failed during agent_plan: provider=${provider.serverName} endpoint=${endpoint} ${errorDiagnostic(err)}`,
        { cause: err },
      );
    }
    const fragment = parseJsonText(formatMcpToolResult(planResult));
    if (!Array.isArray(fragment?.tasks) || fragment.tasks.length === 0) {
      throw new Error(fragment?.summary?.initialSynthesis?.[0] ?? `No task was planned for ${selection.capability}/${selection.operation}.`);
    }
    const validation = validateFragment(fragment, {
      registry: capabilityRegistryForSession(session),
      run: { plannerAgentInstanceId: provider.agentInstanceId ?? provider.serverName },
    });
    if (!validation.ok) {
      throw new Error(`Delegated plan rejected: ${validation.errors.map((error) => error.message ?? error.code ?? String(error)).join('; ')}`);
    }
    return {
      capability: selection.capability,
      operation: selection.operation,
      provider: { serverName: provider.serverName, agentInstanceId: provider.agentInstanceId ?? provider.serverName },
      fragment: validation.normalizedFragment,
      summary: {
        capability: selection.capability,
        operation: selection.operation,
        agent: provider.agentInstanceId ?? provider.serverName,
        tasks: validation.normalizedFragment.tasks.length,
      },
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
      if (body.preparedDelegation?.fragment) {
        const { integrate } = await import('../orchestrator/planIntegrator.js');
        const prepared = body.preparedDelegation;
        const integrated = integrate(runId, prepared.fragment, {
          registry: capabilityRegistryForSession(session),
          session,
          store,
          workspace: session.workspace ?? null,
          enforceApprovalCoverage: true,
        });
        if (!integrated.ok) {
          throw new Error(`Delegated plan integration failed: ${(integrated.errors ?? []).map((error) => error.message ?? error.code ?? String(error)).join('; ')}`);
        }
        emitRuntimeLog(session, `delegation: ${prepared.fragment.tasks.length} validated task(s) integrated from ${prepared.provider.serverName}.agent_plan (${prepared.capability}/${prepared.operation})`);
        // Demandé = consenti: a directly-delegated run carries the user's
        // explicit consent, so auto-approve its initial plan. Persisting a
        // run-scope grant (via the approval manager) makes the scheduler's
        // readyTasks approval check pass, so the tasks run without re-prompting.
        // Replanned tasks are integrated later without a fresh grant.
        if (context.approvalManager?.approve) {
          context.approvalManager.approve({ scope: 'run', runId });
          emitRuntimeLog(session, `approval: run ${runId} auto-approved (user-requested action)`);
        }
        body._planReady?.resolve?.({ runId, planRevision: session.agentProjection?.planRevision ?? 0 });
      }
      // Deterministic capability run (/ingest): ask the capable agent for its
      // task-graph fragment and integrate it as the plan BEFORE any LLM turn.
      // The parallel path must not depend on a small model deciding to call
      // agent_plan by itself.
      if (body.capabilityPlan?.capability) {
        const { validateFragment } = await import('../orchestrator/planValidator.js');
        const { integrate } = await import('../orchestrator/planIntegrator.js');
        const registry = capabilityRegistryForSession(session);
        const agents = session.agentRegistry?.snapshot?.() ?? session.agentRegistrySnapshot ?? [];
        const provider = agents.find((item) => (item.description?.capabilities ?? [])
          .some((capability) => capability.id === body.capabilityPlan.capability));
        if (!provider?.serverName) {
          throw new Error(`No agent provides capability ${body.capabilityPlan.capability}.`);
        }
        const fragment = parseJsonText(formatMcpToolResult(await callMcpTool(session.mcp, provider.serverName, 'agent_plan', {
          capability: body.capabilityPlan.capability,
          operation: body.capabilityPlan.operation ?? undefined,
          workspace: { revision: String(Date.now()) },
          constraints: {
            // The agent declares its capacity. Request/env values are only
            // constraints: they may lower that capacity, never raise it.
            maxConcurrency: resolveCapabilityConcurrency(
              provider,
              body.capabilityPlan.maxConcurrency,
              process.env.WIKI_MANAGER_CAPABILITY_CONCURRENCY,
            ),
            requireApprovalForMutations: body.capabilityPlan.requireApproval !== false,
          },
          ...(Array.isArray(body.capabilityPlan.inputs) && body.capabilityPlan.inputs.length > 0
            ? { arguments: { inputs: body.capabilityPlan.inputs } }
            : {}),
        })));
        if (!Array.isArray(fragment?.tasks) || fragment.tasks.length === 0) {
          dispatchAgentEvent(session, createAgentEvent('assistant_message', {
            origin: 'runtime',
            runId,
            payload: { content: `Aucune tâche à planifier pour ${body.capabilityPlan.capability} (${fragment?.summary?.initialSynthesis?.[0] ?? 'fragment vide'}).` },
          }));
          dispatchAgentEvent(session, createAgentEvent('run_done', { origin: 'runtime', runId, payload: { runId } }));
          return;
        }
        // Full official integration path — NOT a bare plan_set: integrate()
        // validates the fragment, persists the tasks, and CREATES the
        // approval requests the scheduler's approvalCovered() filter waits
        // for. A bare plan_set left requiresApproval tasks unreachable
        // forever (stalled as no_ready_plan_task with nothing to approve).
        const validation = validateFragment(fragment, {
          registry,
          run: { plannerAgentInstanceId: provider.agentInstanceId ?? provider.serverName },
        });
        if (!validation.ok) {
          throw new Error(`Capability plan rejected: ${validation.errors.map((error) => error.message ?? error.code ?? String(error)).join('; ')}`);
        }
        const integrated = integrate(runId, validation.normalizedFragment, {
          registry,
          session,
          store,
          workspace: session.workspace ?? null,
          enforceApprovalCoverage: true,
        });
        if (!integrated.ok) {
          throw new Error(`Capability plan integration failed: ${(integrated.errors ?? []).map((error) => error.message ?? error.code ?? String(error)).join('; ')}`);
        }
        emitRuntimeLog(session, `capability-plan: ${fragment.tasks.length} task(s) integrated from ${provider.serverName}.agent_plan (${body.capabilityPlan.capability}); approvals: ${(session.agentProjection?.approvals ?? []).filter((approval) => approval.status === 'pending_approval').length} pending`);
      }
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
      body._planReady?.reject?.(err);
      if (err?.name === 'AbortError') {
        // Cancel the asynchronous agent jobs the run started: aborting only
        // the manager loop left ingest subprocesses running for minutes with
        // frozen panels.
        await cancelActiveActivityJobs(session).catch(() => {});
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

  async function executeInteractiveTurn(context, body, { signal, turnId } = {}) {
    const input = String(body.input ?? body.prompt ?? '').trim();
    if (!input) throw new Error('Missing input.');
    const ephemeral = createInteractiveSession(context, { runtimeUrl: selfRuntimeUrl, turnId, signal });
    // Seed from a freshly reduced COPY of persisted events. Interactive turn
    // events deliberately do not mutate the canonical run projection, so the
    // canonical session alone is not a reliable conversation-history source.
    const persistedProjection = reduceAgentEvents(store.listEvents({
      workspace: context.workspace ?? ephemeral.workspace ?? null,
    }));
    const messages = conversationSeed({ agentProjection: persistedProjection }, input);
    ephemeral._onAgentEvent = (event) => {
      const interactiveEvent = {
        ...event,
        origin: 'runtime_turn',
        turnId,
        runId: null,
        workspace: context.workspace ?? ephemeral.workspace ?? null,
      };
      store.persistEvent(interactiveEvent);
      serverHandle?.publish(interactiveEvent);
    };
    ephemeral._onStep = (message) => dispatchAgentEvent(ephemeral, createAgentEvent('runtime_log', {
      origin: 'runtime_turn',
      turnId,
      workspace: context.workspace ?? null,
      payload: { message },
    }));
    dispatchAgentEvent(ephemeral, createAgentEvent('user_message', {
      origin: 'runtime_turn',
      turnId,
      workspace: context.workspace ?? null,
      payload: { content: input },
    }));
    // Read-only chat turn: same chatAccess policy as the Shell UI's /chat, now
    // reachable over HTTP so `wiki serve` chat mode gets read tools without
    // duplicating the loop. Anything other than mode === 'chat' stays the full
    // unrestricted agent turn.
    const chatMode = String(body.mode ?? '').toLowerCase() === 'chat';
    let response;
    if (chatMode) {
      ephemeral.chatMode = true;
      ephemeral.chatAccess = readChatAccessConfig();
      const history = messages.length && messages[messages.length - 1]?.role === 'user'
        ? messages.slice(0, -1)
        : messages;
      response = await runHeadlessChatTurn(ephemeral, input, {
        history,
        onStep: ephemeral._onStep,
        // UI context from `wiki serve`: up to five selected wiki or raw
        // documents. Only paths are prompted; Donna reads through tools.
        openWikiPages: body.context?.openWikiPages ?? body.context?.openWikiPage,
      });
    } else {
      response = await runAgentTurn(agent, ephemeral, input, { messages, signal });
    }
    ensureInteractiveAssistantMessage(ephemeral, response, {
      turnId,
      workspace: context.workspace ?? null,
    });
    return response;
  }

  serverHandle = await startRuntimeServer({
    host,
    port,
    store,
    getContext: getWorkspaceContext,
    listActiveRuns: () => [...contexts.values()]
      .filter((context) => context?.running)
      .map((context) => ({ workspace: context.workspace ?? null, runId: context.currentRunId ?? null })),
    run: executeRun,
    turn: executeInteractiveTurn,
    delegate: prepareDelegation,
    cancel: (context) => emitRuntimeLog(context.session, 'runtime: cancel requested'),
    resume: ({ workspace }) => recoverRuntime({ workspace, manual: true }),
    approve: (request) => forwardRuntimeApproval(getWorkspaceContext, request),
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
    const scaffolded = ensureManagerScaffold({ log: (message) => console.log(`[wiki-manager] ${message}`) });
    if (scaffolded.length > 0) loadManagerEnv();
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
    // Fresh directory → copy mcp.endpoints.json/.env from the packaged
    // examples so external agents (cme, mailer, documents) connect out of
    // the box. Done here (and in `runtime`), NOT at import time: --version
    // in a random cwd must not litter files.
    const scaffolded = ensureManagerScaffold({ log: (message) => console.log(`[wiki-manager] ${message}`) });
    if (scaffolded.length > 0) loadManagerEnv();
    const reportCheck = ({ kind, ok, detail, context, skipped, pending }) => {
      const labels = { docker: 'Docker', internet: 'Internet', agents: 'Agent containers', workspace: 'Workspaces', containers: 'Workspace containers', mcp: 'MCP' };
      const label = labels[kind] ?? kind;
      const instruction = !ok && context?.command ? ` — command: ${context.command}` : '';
      const suffix = detail ? ` — ${detail}` : ` — ${context?.error ?? context?.dockerError ?? 'waiting'}`;
      const color = ok ? '\x1b[32m' : '\x1b[33m';
      const state = ok ? 'ready' : pending || skipped ? 'waiting' : 'needs attention';
      const icon = ok ? '✓' : pending || skipped ? '◐' : '✗';
      console.log(`${color}${icon} configuration: ${label} ${state}${suffix}${instruction}\x1b[0m`);
    };
    let preflight = await runPreflightChecks({ onCheck: reportCheck });
    if (preflight.gaps.length > 0) {
      await runStartupWizard(preflight.gaps);
      // The wizard may have created a workspace, started agents or repaired
      // configuration. Re-read everything before drawing the home screen.
      preflight = await runPreflightChecks();
    }
    let runtime = null;
    try {
      const { ensureRuntime } = await import('../runtime/lifecycle.js');
      // If the manager files were just scaffolded, a pre-existing runtime
      // predates them: restart it so its sessions load the new endpoints.
      runtime = await ensureRuntime({ forceRestart: scaffolded.length > 0 });
    } catch (err) {
      runtime = unavailableRuntime(err);
      console.error(`Runtime unavailable: ${runtime.error}`);
    }
    preflight = withRuntimePreflight(preflight, runtime);
    // The owned-runtime shutdown happens inside the TUI's own exit paths
    // (see tui.tsx onShellExit): render() resolves at MOUNT, so anything
    // after this await would run while the shell is still on screen —
    // 0.12.9 shipped exactly that bug and killed the runtime under the user.
    await runOpenTuiShell({ agent, packageJson, runtime, preflight });
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
  if (runtime?.url) {
    const { shutdownOwnedRuntime } = await import('../runtime/lifecycle.js');
    await shutdownOwnedRuntime(runtime, { log: (message) => console.log(`[wiki-manager] ${message}`) });
  }
}
