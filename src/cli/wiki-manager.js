import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentGraph, buildAgentSystemPrompt, buildLimitedAgentResponse } from '../agent/graph.js';
import { handleSlashCommand, printHelp, printVersion } from '../commands/slash.js';
import { runShell } from '../shell/repl.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { parseJsonText, sessionActivities, rememberActivityFromPayload } from '../core/activity.js';
import { extractHeadlessPlan, syncActivitiesToPlan, formatPlanStatus, formatCompletedActivities, ensurePlanFromActivity } from '../core/plan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const SHELL_COMMANDS = ['help', 'version', 'exit', 'workspaces', 'new', 'use', 'config', 'status', 'services', 'start', 'stop', 'logs', 'mcp', 'wiki', 'skills', 'clear', 'chat', 'agent'];

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
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

function activitySnapshot(session) {
  return new Set(sessionActivities(session).map((a) => a.key));
}

function newNonTerminalActivities(snapshotBefore, session) {
  return sessionActivities(session).filter((a) => !snapshotBefore.has(a.key) && !a.terminal);
}

function terminalFailures(activities) {
  return activities.filter(
    (a) => a.terminal && ['failed', 'error', 'cancelled', 'canceled'].includes(String(a.status).toLowerCase()),
  );
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
        const polledActivity = rememberActivityFromPayload(session, payload, { server: activity.poll.server, tool: activity.poll.tool });
        if (polledActivity) ensurePlanFromActivity(session, polledActivity);
        syncActivitiesToPlan(session.headlessPlan, sessionActivities(session));
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

async function runHeadlessAgentTurn(agent, session, input, log, messages = []) {
  session.packageJson = packageJson;
  let streamedContent = '';
  session._onStream = (delta) => { streamedContent += delta; };
  session._onStreamReset = () => { streamedContent = ''; };
  let result;
  try {
    result = await agent.invoke({ input, session, messages });
  } finally {
    delete session._onStream;
    delete session._onStreamReset;
  }
  if (result.streamedInline) {
    return streamedContent.trim() || buildLimitedAgentResponse({ input, session }, 'LLM stream ended without content');
  }
  if (result.response != null) return result.response;
  if (result.readyToStream && session.llm?.stream) {
    const { system, messages: streamMessages = [] } = result.streamContext ?? {};
    let content = '';
    for await (const delta of session.llm.stream({
      system: system ?? buildAgentSystemPrompt({ input, session }),
      messages: streamMessages,
    })) {
      content += delta;
    }
    return content.trim() || buildLimitedAgentResponse({ input, session }, 'LLM stream ended without content');
  }
  return buildLimitedAgentResponse({ input, session });
}

async function runHeadlessAgenticLoop(agent, session, initialInput, log, { timeoutMs, maxTurns }) {
  const conversationHistory = [];
  let currentInput = initialInput;

  for (let turn = 1; turn <= maxTurns; turn++) {
    log.push(`agentic-loop: turn ${turn}/${maxTurns}`);
    console.log(`[headless] Agent turn ${turn}/${maxTurns}…`);

    const snapshot = activitySnapshot(session);

    const response = await runHeadlessAgentTurn(agent, session, currentInput, log, conversationHistory);
    log.push(`agentic-loop: turn ${turn} response:`);
    log.push(response);
    console.log(response);

    conversationHistory.push(
      { role: 'user', content: currentInput },
      { role: 'assistant', content: response },
    );

    // session.headlessPlan is set authoritatively by wiki__plan_set tool call.
    // Fall back to text extraction only if the agent didn't call the tool.
    if (turn === 1 && session.headlessPlan === null) {
      session.headlessPlan = extractHeadlessPlan(response);
      if (session.headlessPlan) log.push(`agentic-loop: plan extracted from text (${session.headlessPlan.length} steps, fallback)`);
    } else if (turn === 1 && session.headlessPlan) {
      log.push(`agentic-loop: plan set via tool (${session.headlessPlan.length} steps)`);
    }

    const newPending = newNonTerminalActivities(snapshot, session);
    if (newPending.length === 0) {
      const pendingSteps = (session.headlessPlan ?? []).filter((s) => s.status === 'pending');
      if (pendingSteps.length === 0) {
        log.push('agentic-loop: no new non-terminal activities — plan complete');
        console.log('[headless] Plan complete.');
        return { exitCode: 0 };
      }
      log.push(`agentic-loop: no new async activity, ${pendingSteps.length} pending step(s) remain`);
      if (session.headlessPlan) log.push(`agentic-loop: plan status:\n${formatPlanStatus(session.headlessPlan)}`);
      currentInput = [
        'Original task:',
        initialInput,
        '',
        `Plan status:\n${formatPlanStatus(session.headlessPlan)}`,
        '',
        'No new background activity was started in the previous turn.',
        'Continue the original plan. Start the next pending step only.',
        'If required information is missing and cannot be inferred, stop with a clear blocker.',
      ].join('\n');
      continue;
    }

    log.push(`agentic-loop: ${newPending.length} new job(s) started, waiting…`);
    const { exitCode, completed, timedOut } = await runHeadlessActivityLoop(session, log, { wait: true, timeoutMs });

    if (timedOut || exitCode !== 0) return { exitCode };

    syncActivitiesToPlan(session.headlessPlan, completed);

    const summary = formatCompletedActivities(completed);
    log.push(`agentic-loop: completed activities:\n${summary}`);
    if (session.headlessPlan) log.push(`agentic-loop: plan status:\n${formatPlanStatus(session.headlessPlan)}`);
    currentInput = [
      'Original task:',
      initialInput,
      '',
      session.headlessPlan ? `Plan status:\n${formatPlanStatus(session.headlessPlan)}\n` : null,
      'Completed activities:',
      summary,
      '',
      'Continue the original plan. Start the next required step only.',
      'If all steps are complete, provide the final summary.',
    ].filter(Boolean).join('\n');
  }

  log.push(`agentic-loop: max turns (${maxTurns}) reached without completing`);
  console.error(`[headless] Max agent turns (${maxTurns}) reached.`);
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
    let exitCode = 0;
    if (useAgenticLoop) {
      ({ exitCode } = await runHeadlessAgenticLoop(agent, session, input, log, { timeoutMs, maxTurns }));
    } else {
      const response = await runHeadlessAgentTurn(agent, session, input, log);
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

export async function runCli(argv) {
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
    const { runOpenTuiShell } = await import('../shell/tui.tsx');
    await runOpenTuiShell({ agent, packageJson });
    return;
  }

  await runShell({ agent, packageJson });
}
