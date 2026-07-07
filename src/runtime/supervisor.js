import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { extractActivity, parseJsonText, sessionActivities } from '../core/activity.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { startNextQueuedJob, syncQueueWithActivity } from '../core/jobQueue.js';
import { createAgentRegistry } from '../orchestrator/agentRegistry.js';

export function startActivitySupervisor(session, {
  intervalMs = 1000,
  queueIntervalMs = 10000,
  agentRegistryIntervalMs = registryIntervalFromEnv(),
  agentRegistry = null,
  callTool = callMcpTool,
} = {}) {
  const pollBusy = new Set();
  let stopped = false;
  let runSignal = null;
  const registry = agentRegistry ?? createAgentRegistry({ callTool });
  session.agentRegistry ??= registry;

  const pollTimer = setInterval(() => {
    void pollActivitiesOnce(session, { pollBusy, callTool, signal: runSignal });
  }, intervalMs);

  const queueTimer = setInterval(() => {
    if (session.jobQueue?.some((item) => item.status === 'waiting')) {
      void startNextQueuedJob(session, {
        addLog: (message) => emitRuntimeLog(session, message),
      });
    }
  }, queueIntervalMs);

  const agentRegistryTimer = agentRegistryIntervalMs > 0
    ? setInterval(() => {
      void discoverAgentsOnce(session, { registry, signal: runSignal });
    }, agentRegistryIntervalMs)
    : null;

  void pollActivitiesOnce(session, { pollBusy, callTool, signal: runSignal });
  void discoverAgentsOnce(session, { registry, signal: runSignal });

  return {
    pollBusy,
    setRunSignal(signal) {
      runSignal = signal ?? null;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(queueTimer);
      if (agentRegistryTimer) clearInterval(agentRegistryTimer);
      pollBusy.clear();
    },
  };
}

export async function discoverAgentsOnce(session, {
  registry = session?.agentRegistry ?? createAgentRegistry(),
  signal = null,
} = {}) {
  if (!session) return [];
  session.agentRegistry ??= registry;
  return registry.discover(session, { signal });
}

export async function pollActivitiesOnce(session, {
  pollBusy = new Set(),
  callTool = callMcpTool,
  signal = null,
} = {}) {
  for (const activity of sessionActivities(session)) {
    if (signal?.aborted) break;
    if (activity.terminal || !activity.poll) continue;
    const key = activity.key ?? `${activity.poll.server}:${activity.id ?? activity.label}`;
    if (pollBusy.has(key)) continue;
    const endpoint = session.mcp?.[activity.poll.server];
    if (!endpoint || endpoint.status !== 'connected') {
      emitRuntimeLog(session, `activity: MCP server '${activity.poll.server}' not connected, cannot poll ${key}`);
      continue;
    }
    const intervalMs = activity.poll.intervalMs ?? 2500;
    const lastPolledAt = Date.parse(activity.lastPolledAt ?? '0');
    if (Date.now() - lastPolledAt < intervalMs) continue;

    pollBusy.add(key);
    activity.lastPolledAt = new Date().toISOString();
    try {
      const result = await callTool(session.mcp, activity.poll.server, activity.poll.tool, activity.poll.args ?? {}, signal);
      const payload = parseJsonText(formatMcpToolResult(result));
      const polledActivity = extractActivity(payload, {
        server: activity.poll.server,
        tool: activity.poll.tool,
      });
      if (polledActivity) {
        dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
          origin: 'runtime_poll',
          payload: { activity: polledActivity },
        }));
        syncQueueWithActivity(session, polledActivity);
        emitRuntimeLog(session, `activity: ${polledActivity.label} -> ${polledActivity.status}`);
        if (polledActivity.terminal) {
          await startNextQueuedJob(session, {
            addLog: (message) => emitRuntimeLog(session, message),
          });
          const remainingPollable = sessionActivities(session).filter((a) => !a.terminal && a.poll);
          if (remainingPollable.length === 0 && typeof session._onActivitiesTerminal === 'function') {
            const cb = session._onActivitiesTerminal;
            delete session._onActivitiesTerminal;
            cb(session);
          }
        }
      }
    } catch (err) {
      emitRuntimeLog(session, `activity poll error ${key}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pollBusy.delete(key);
    }
  }
}

export function emitRuntimeLog(session, message) {
  dispatchAgentEvent(session, createAgentEvent('runtime_log', {
    origin: 'runtime',
    payload: { message },
  }));
}

function registryIntervalFromEnv() {
  const value = Number(process.env.WIKI_MANAGER_AGENT_REGISTRY_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 60000;
}
