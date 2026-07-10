import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { extractActivity, parseJsonText, sessionActivities } from '../core/activity.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { normalizeRuntimeLog } from '../core/runtimeLog.js';
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
        // Only log when something actually changed: the poll fires every
        // second and an unchanged "activity: X -> running" line repeated
        // dozens of times drowned Logs/Trace and looked like a frozen system.
        // The line itself carries the operational signal (current file,
        // percent, batch, last trace event, retry/backoff) so the panel
        // reads as a narrative of the job, not a heartbeat.
        const progress = payload?.progress ?? polledActivity.progress ?? {};
        const percent = Number(progress.percent ?? polledActivity.progress?.percent);
        const detail = progress.detail ?? progress.step ?? '';
        // The trace's batchIndex is 0-based and the human detail already says
        // "Batch 1/2" — printing both gave "Batch 1/2 · batch 0/2". Display
        // 1-based, and only when the detail doesn't already carry it.
        const batch = progress.batchIndex != null && progress.batchCount != null && !/batch/i.test(String(detail))
          ? `batch ${Number(progress.batchIndex) + 1}/${progress.batchCount}`
          : null;
        const lastEvent = progress.lastEvent ? String(progress.lastEvent) : null;
        const retry = progress.retryAt
          ? `retry ${progress.retryAt}`
          : (progress.waitMs ? `wait ${progress.waitMs}ms` : null);
        // retryAt/waitMs are scheduling metadata and may be recomputed on every
        // status poll. They must remain visible in the first log line, but must
        // not turn an unchanged quota/backoff state into a new trace event.
        const progressKey = `${polledActivity.status}:${Number.isFinite(percent) ? Math.round(percent) : ''}:${detail}:${batch ?? ''}:${lastEvent ?? ''}`;
        session._activityLogKeys ??= {};
        if (session._activityLogKeys[key] !== progressKey) {
          session._activityLogKeys[key] = progressKey;
          const progressLabel = [
            Number.isFinite(percent) ? `${Math.round(percent)}%` : null,
            detail ? String(detail) : null,
            batch,
            lastEvent,
            retry,
          ].filter(Boolean).join(' · ');
          emitRuntimeLog(session, `activity: ${polledActivity.label} -> ${polledActivity.status}${progressLabel ? ` (${progressLabel})` : ''}`);
        }
        // Stream NEW job-log lines into Logs/Trace: document names, chunking,
        // LLM call/token summaries and errors live in the job log, not in the
        // status fields. Diff against the last line already shown.
        const logTail = Array.isArray(payload?.logTail) ? payload.logTail.map(String) : [];
        if (logTail.length > 0) {
          session._activityLogCursors ??= {};
          const lastSeen = session._activityLogCursors[key];
          const lastIndex = lastSeen ? logTail.lastIndexOf(lastSeen) : -1;
          for (const line of logTail.slice(lastIndex + 1)) {
            const clean = line.trim();
            if (clean) emitRuntimeLog(session, `job ${polledActivity.id ?? key}: ${clean}`);
          }
          session._activityLogCursors[key] = logTail.at(-1);
        }
        // The job log is terse — the actual narrative (per-document plans,
        // LLM calls with token counts, apply operations) lives in the
        // engine's trace file, whose path the status exposes. Tail it from
        // the host and surface the significant events.
        if (progress.traceFile) {
          for (const line of readNewTraceLines(session, key, progress.traceFile)) {
            emitRuntimeLog(session, `trace: ${line}`);
          }
        }
        if (polledActivity.terminal) {
          delete session._activityLogKeys[key];
          delete session._activityLogCursors?.[key];
          delete session._activityTraceCursors?.[key];
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
  const payload = normalizeRuntimeLog(message, { session });
  dispatchAgentEvent(session, createAgentEvent('runtime_log', {
    origin: 'runtime',
    runId: payload.runId ?? null,
    taskId: payload.taskId ?? null,
    workspace: payload.workspaceId ?? null,
    payload,
  }));
}

function registryIntervalFromEnv() {
  const value = Number(process.env.WIKI_MANAGER_AGENT_REGISTRY_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 60000;
}

// Cancelling a runtime run must also cancel the asynchronous jobs it started:
// the run's abort only stopped the manager-side loop while the agent kept
// executing (an ingest subprocess ran on for minutes after "cancel requested",
// with the panels frozen on its last known state). Best effort: prefer the
// orchestration contract's agent_cancel, fall back to legacy *_cancel_job.
export async function cancelActiveActivityJobs(session, { callTool = callMcpTool } = {}) {
  const cancelled = [];
  for (const activity of sessionActivities(session)) {
    if (activity.terminal || !activity.poll) continue;
    const jobId = activity.poll.args?.jobId ?? activity.id ?? null;
    const server = activity.poll.server;
    const endpoint = session.mcp?.[server];
    if (!jobId || !endpoint || endpoint.status !== 'connected') continue;
    const names = (endpoint.tools ?? []).map((tool) => String(tool.name ?? ''));
    const cancelTool = names.find((name) => /(^|__)agent_cancel$/.test(name))
      ?? names.find((name) => /_cancel_job$/.test(name))
      ?? names.find((name) => /(^|__)[a-z]*_?cancel$/.test(name));
    if (!cancelTool) continue;
    try {
      await callTool(session.mcp, server, cancelTool, { jobId });
      emitRuntimeLog(session, `cancel: requested ${server}.${cancelTool} for job ${jobId}`);
      cancelled.push({ server, jobId });
    } catch (err) {
      emitRuntimeLog(session, `cancel: ${server}.${cancelTool} failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cancelled;
}

// Trace events worth surfacing in the chat-side log: plan/apply milestones,
// LLM calls (with token counts), warnings and errors. The raw trace is far
// chattier — streaming everything would recreate the noise the dedupe killed.
const TRACE_EVENT_PATTERN = /\b(llm:start|llm:end|llm:json|llm:error|ingest:plan|ingest:operations|ingest:apply|ingest:source|build:template|retrieval:|embedding:|WARN|ERROR)\b/;
const TRACE_MAX_BYTES_PER_POLL = 64 * 1024;
const TRACE_MAX_LINES_PER_POLL = 12;

export function readNewTraceLines(session, key, traceFile) {
  const workspacePath = session?.workspacePath;
  if (!workspacePath) return [];
  // The trace path comes from an agent payload: never let it escape the
  // workspace directory.
  const resolved = resolve(workspacePath, normalize(String(traceFile)));
  if (isAbsolute(String(traceFile)) || !resolved.startsWith(resolve(workspacePath))) return [];
  let fd;
  try {
    fd = openSync(resolved, 'r');
    const size = fstatSync(fd).size;
    session._activityTraceCursors ??= {};
    let offset = session._activityTraceCursors[key];
    // First sighting (or file rotation): start near the end, not at byte 0 —
    // replaying a long history would flood the panel.
    if (offset == null || offset > size) offset = Math.max(0, size - 4096);
    if (size <= offset) return [];
    const length = Math.min(size - offset, TRACE_MAX_BYTES_PER_POLL);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    const chunk = buffer.toString('utf8');
    // Only advance past COMPLETE lines so a partially-written line is
    // re-read whole on the next poll.
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return [];
    session._activityTraceCursors[key] = offset + Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');
    return chunk
      .slice(0, lastNewline)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && TRACE_EVENT_PATTERN.test(line))
      .slice(0, TRACE_MAX_LINES_PER_POLL)
      // Strip the ISO timestamp + elapsed prefix: the runtime log adds its
      // own clock, and the double timestamp ate half the panel width.
      .map((line) => line.replace(/^\S+\s+\+[\d.]+(?:ms|s|m|h)\s+(INFO|WARN|ERROR)\s+/, (_m, level) => (level === 'INFO' ? '' : `${level} `)));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
