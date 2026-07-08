import { normalizeActivity, parseJsonText } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { emitRuntimeLog, pollActivitiesOnce } from '../runtime/supervisor.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'canceled', 'complete', 'completed', 'success', 'error']);

export function createDispatcher({
  session = null,
  callTool = callMcpTool,
  pollIntervalMs = 250,
} = {}) {
  return {
    execute(task, assignment, options = {}) {
      return execute(task, assignment, {
        session,
        callTool,
        pollIntervalMs,
        ...options,
      });
    },
  };
}

export async function execute(task, assignment, {
  session,
  callTool = callMcpTool,
  signal = null,
  runId = null,
  attempt = null,
  timeoutMs = null,
  pollBusy = new Set(),
  pollIntervalMs = 250,
} = {}) {
  if (!session) throw new Error('dispatcher.execute requires session.');
  if (!assignment?.serverName) throw new Error(`No MCP server found for agent ${assignment?.agentInstanceId ?? '(unknown)'}.`);
  const serverName = assignment.serverName;
  const executeTool = toolNameFor(session, serverName, 'agent_execute');
  const statusTool = toolNameFor(session, serverName, 'agent_status');
  const cancelTool = toolNameFor(session, serverName, 'agent_cancel');
  const taskTimeoutMs = resolvedTimeoutMs(assignment, timeoutMs);
  const deadline = Date.now() + taskTimeoutMs;
  let jobId = null;
  let lastStatus = null;

  try {
    emitRuntimeLog(session, taskLogPayload('agent_execute', task, assignment, {
      runId,
      attempt,
      detail: executeTool,
    }));
    const accepted = parseToolPayload(await callTool(
      session.mcp,
      serverName,
      executeTool,
      executeRequest(task, session),
      signal,
    ));
    if (accepted?.accepted === false || accepted?.ok === false) {
      throw new Error(String(accepted.error ?? 'agent_execute rejected task'));
    }
    jobId = String(accepted.jobId ?? '');
    if (!jobId) throw new Error('agent_execute did not return jobId.');
    emitRuntimeLog(session, taskLogPayload('job.accepted', task, assignment, {
      runId,
      attempt,
      jobId,
      agentId: accepted.agentId ?? null,
      detail: accepted.status ?? 'accepted',
    }));
    dispatchAgentEvent(session, createAgentEvent('task.started', {
      origin: 'dispatcher',
      runId,
      taskId: String(task.id ?? task.step),
      payload: {
        runId,
        taskId: String(task.id ?? task.step),
        attemptId: attempt?.attemptId ?? null,
        agentInstanceId: assignment.agentInstanceId,
        jobId,
        startedAt: new Date().toISOString(),
      },
    }));
    dispatchTaskActivity(session, task, assignment, jobId, statusTool, runId);

    while (true) {
      throwIfAborted(signal);
      if (Date.now() > deadline) {
        throw new Error(`Task timed out after ${taskTimeoutMs}ms.`);
      }
      await pollActivitiesOnce(session, {
        pollBusy,
        signal,
        callTool: async (mcp, pollServer, pollTool, args, pollSignal) => {
          const result = await callTool(mcp, pollServer, pollTool, args, pollSignal);
          if (pollServer === serverName && pollTool === statusTool && String(args?.jobId ?? '') === jobId) {
            lastStatus = parseToolPayload(result);
          }
          return result;
        },
      });
      if (!lastStatus) {
        emitRuntimeLog(session, taskLogPayload('agent_status', task, assignment, {
          runId,
          attempt,
          jobId,
          detail: statusTool,
        }));
        lastStatus = parseToolPayload(await callTool(session.mcp, serverName, statusTool, { jobId }, signal));
      }
      if (isTerminal(lastStatus?.status ?? lastStatus?.result?.status)) {
        emitRuntimeLog(session, taskLogPayload('task.result_returned', task, assignment, {
          runId,
          attempt,
          jobId,
          status: lastStatus?.result?.status ?? lastStatus?.status,
          outputs: lastStatus?.result?.outputRefs ?? [],
          error: lastStatus?.result?.error?.code ?? lastStatus?.result?.error?.message ?? null,
          detail: 'terminal status',
        }));
        return taskResultFromStatus(task, assignment, jobId, lastStatus, attempt);
      }
      await delay(pollIntervalMs, signal);
      emitRuntimeLog(session, taskLogPayload('agent_status', task, assignment, {
        runId,
        attempt,
        jobId,
        detail: statusTool,
      }));
      lastStatus = parseToolPayload(await callTool(session.mcp, serverName, statusTool, { jobId }, signal));
      if (isTerminal(lastStatus?.status ?? lastStatus?.result?.status)) {
        emitRuntimeLog(session, taskLogPayload('task.result_returned', task, assignment, {
          runId,
          attempt,
          jobId,
          status: lastStatus?.result?.status ?? lastStatus?.status,
          outputs: lastStatus?.result?.outputRefs ?? [],
          error: lastStatus?.result?.error?.code ?? lastStatus?.result?.error?.message ?? null,
          detail: 'terminal status',
        }));
        return taskResultFromStatus(task, assignment, jobId, lastStatus, attempt);
      }
    }
  } catch (error) {
    if (isAbortError(error) && jobId) {
      await callTool(session.mcp, serverName, cancelTool, { jobId }, null).catch(() => null);
    }
    throw error;
  } finally {
    emitRuntimeLog(session, taskLogPayload('lock.released', task, assignment, {
      runId,
      attempt,
      jobId,
      detail: attempt?.locks?.join(',') || 'no locks',
    }));
    attempt?.release?.();
  }
}

function executeRequest(task, session) {
  return {
    taskId: String(task.id ?? task.step),
    operation: task.operation,
    workspace: workspaceRequest(session),
    arguments: task.arguments && typeof task.arguments === 'object' ? task.arguments : {},
    constraints: {
      requireApprovalForMutations: task.requiresApproval === true,
    },
  };
}

function workspaceRequest(session) {
  const workspace = session.workspace ?? session._currentRunIdentity?.workspace;
  if (workspace && typeof workspace === 'object' && !Array.isArray(workspace)) return { ...workspace };
  return { name: String(workspace ?? 'workspace') };
}

function dispatchTaskActivity(session, task, assignment, jobId, statusTool, runId) {
  const activity = normalizeActivity({
    id: jobId,
    source: assignment.serverName,
    kind: task.operation ?? task.requiredCapability ?? 'task',
    label: task.label ?? task.description ?? String(task.id ?? task.step),
    status: 'queued',
    progress: { percent: 0, stepId: String(task.id ?? task.step) },
    poll: {
      server: assignment.serverName,
      tool: statusTool,
      args: { jobId },
      intervalMs: 1000,
    },
    outputRefs: [],
  });
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    origin: 'dispatcher',
    runId,
    taskId: String(task.id ?? task.step),
    payload: { activity },
  }));
}

function taskResultFromStatus(task, assignment, jobId, statusPayload, attempt = null) {
  const result = statusPayload?.result ?? {};
  const resultStatus = String(result.status ?? statusPayload?.status ?? '').toLowerCase();
  const ok = ['succeeded', 'success', 'done', 'complete', 'completed'].includes(resultStatus);
  return {
    ok,
    taskId: String(task.id ?? task.step),
    attemptId: statusPayload?.attemptId ?? attempt?.attemptId ?? null,
    jobId,
    agentInstanceId: assignment.agentInstanceId,
    status: result.status ?? statusPayload?.status,
    outputRefs: Array.isArray(result.outputRefs) ? result.outputRefs : [],
    metrics: result.metrics ?? {},
    error: result.error ?? null,
    rawStatus: statusPayload,
  };
}

function toolNameFor(session, serverName, baseName) {
  const tools = session.mcp?.[serverName]?.tools ?? [];
  const names = tools.map((tool) => String(tool.name ?? '')).filter(Boolean);
  return names.find((name) => name === baseName)
    ?? names.find((name) => name === `${serverName}__${baseName}`)
    ?? names.find((name) => name.endsWith(`__${baseName}`))
    ?? baseName;
}

function parseToolPayload(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && !Array.isArray(result.content)) return result;
  return parseJsonText(formatMcpToolResult(result)) ?? {};
}

function resolvedTimeoutMs(assignment, timeoutMs) {
  const agentLimit = Number(assignment?.agent?.description?.limits?.maxTaskDurationMs ?? assignment?.description?.limits?.maxTaskDurationMs);
  if (Number.isFinite(agentLimit) && agentLimit > 0) return agentLimit;
  const runtimeLimit = Number(timeoutMs);
  return Number.isFinite(runtimeLimit) && runtimeLimit > 0 ? runtimeLimit : 600_000;
}

function taskLogPayload(event, task, assignment, {
  runId = null,
  attempt = null,
  jobId = null,
  agentId = null,
  status = null,
  outputs = null,
  error = null,
  detail = null,
} = {}) {
  return {
    event,
    runId,
    planRevision: task?.planRevision ?? null,
    groupId: task?.groupId ?? null,
    taskId: String(task?.id ?? task?.step),
    attemptId: attempt?.attemptId ?? null,
    agentType: assignment?.agent?.description?.agentType ?? assignment?.description?.agentType ?? null,
    agentInstanceId: assignment?.agentInstanceId ?? null,
    agentId: agentId ?? assignment?.agentId ?? null,
    jobId,
    capability: task?.requiredCapability ?? assignment?.capability ?? null,
    operation: task?.operation ?? assignment?.operation ?? null,
    status,
    outputs,
    error,
    detail,
  };
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status ?? '').toLowerCase());
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error('Runtime run cancelled.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}
