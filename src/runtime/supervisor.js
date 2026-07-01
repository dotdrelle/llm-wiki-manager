import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { extractActivity, parseJsonText, sessionActivities } from '../core/activity.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { startNextQueuedJob, syncQueueWithActivity } from '../core/jobQueue.js';

export function startActivitySupervisor(session, {
  intervalMs = 1000,
  queueIntervalMs = 10000,
  callTool = callMcpTool,
} = {}) {
  const pollBusy = new Set();
  let stopped = false;
  let runSignal = null;

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

  void pollActivitiesOnce(session, { pollBusy, callTool, signal: runSignal });

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
      pollBusy.clear();
    },
  };
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
