import { parseJsonText } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { formatMcpToolResult, callMcpTool as defaultCallMcpTool } from '../core/mcp.js';
import { accept as acceptResult } from '../orchestrator/resultAggregator.js';

const ACTIVE_TASK_STATUSES = new Set(['running', 'queued', 'starting', 'assigned']);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'canceled', 'completed', 'complete', 'success', 'succeeded']);

export async function recoverActiveRuns({
  store,
  session,
  workspace = null,
  callTool = defaultCallMcpTool,
  resultAggregator = acceptResult,
} = {}) {
  if (!store) throw new Error('recoveryManager requires store.');
  if (!session) throw new Error('recoveryManager requires session.');
  const runs = store.listRecoverableRuns?.({ workspace }) ?? [];
  const recovered = [];
  const rescheduled = [];
  const interrupted = [];
  const errors = [];

  for (const run of runs) {
    const tasks = store.listTasks?.({ runId: run.id }) ?? [];
    const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(String(task.status ?? '').toLowerCase()));
    for (const task of activeTasks) {
      try {
        const outcome = await recoverTask({ store, session, run, task, callTool, resultAggregator });
        if (outcome?.status === 'recovered') recovered.push(outcome);
        else if (outcome?.status === 'rescheduled') rescheduled.push(outcome);
        else if (outcome?.status === 'interrupted') interrupted.push(outcome);
      } catch (error) {
        errors.push({ runId: run.id, taskId: task.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    ok: errors.length === 0,
    recovered,
    rescheduled,
    interrupted,
    errors,
  };
}

async function recoverTask({ store, session, run, task, callTool, resultAggregator }) {
  const attempt = latestAttempt(store.listTaskAttempts?.({ taskId: task.id }) ?? []);
  const assignment = latestAssignment(store.listTaskAssignments?.({ taskId: task.id }) ?? [], attempt?.attemptId);
  if (!attempt?.jobId || !assignment?.agentInstanceId) {
    return interruptTask({ store, session, run, task, reason: 'missing attempt job or assignment' });
  }

  const agent = agentFor(session, assignment.agentInstanceId);
  const serverName = agent?.serverName ?? assignment.agentId ?? assignment.agentInstanceId;
  const statusTool = toolNameFor(session, serverName, 'agent_status');
  const status = parseToolPayload(await callTool(session.mcp, serverName, statusTool, { jobId: attempt.jobId }));

  if (isTerminal(status?.status ?? status?.result?.status)) {
    const result = taskResultFromStatus(task, assignment, attempt.jobId, status, attempt);
    await resultAggregator(result, {
      session,
      runId: run.id,
      task,
      assignment: {
        agentInstanceId: assignment.agentInstanceId,
        serverName,
        agent,
      },
      store,
      registry: session.capabilityRegistry ?? null,
      workspaceConfig: session.wikircConfig ?? session.wikirc?.config ?? {},
      callTool,
    });
    return { status: 'recovered', runId: run.id, taskId: task.id, jobId: attempt.jobId };
  }

  if (task.idempotencyKey) {
    dispatch(session, store, 'plan_step_updated', {
      origin: 'recovery_manager',
      runId: run.id,
      taskId: task.id,
        workspace: run.workspace ?? workspaceFromSession(session),
      payload: {
        taskId: task.id,
        status: 'pending',
        recovery: {
          reason: 'active_job_requeued_by_idempotency',
          jobId: attempt.jobId,
          idempotencyKey: task.idempotencyKey,
          agentInstanceId: assignment.agentInstanceId,
        },
      },
    });
    return { status: 'rescheduled', runId: run.id, taskId: task.id, jobId: attempt.jobId, idempotencyKey: task.idempotencyKey };
  }

  return interruptTask({ store, session, run, task, reason: 'active job is non-terminal and task has no idempotencyKey' });
}

function interruptTask({ store, session, run, task, reason }) {
  dispatch(session, store, 'runtime_log', {
    origin: 'recovery_manager',
    runId: run.id,
    taskId: task.id,
    workspace: run.workspace ?? workspaceFromSession(session),
    payload: { message: `recovery: ${task.id} interrupted (${reason})` },
  });
  return { status: 'interrupted', runId: run.id, taskId: task.id, reason };
}

function latestAttempt(attempts) {
  return [...attempts].sort((a, b) => String(b.startedAt ?? b.finishedAt ?? b.attemptId).localeCompare(String(a.startedAt ?? a.finishedAt ?? a.attemptId)))[0] ?? null;
}

function latestAssignment(assignments, attemptId) {
  if (attemptId) {
    const matched = assignments.find((assignment) => assignment.attemptId === attemptId);
    if (matched) return matched;
  }
  return [...assignments].sort((a, b) => String(b.assignedAt ?? b.attemptId).localeCompare(String(a.assignedAt ?? a.attemptId)))[0] ?? null;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status ?? '').toLowerCase());
}

function parseToolPayload(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && !Array.isArray(result.content)) return result;
  return parseJsonText(formatMcpToolResult(result)) ?? {};
}

function taskResultFromStatus(task, assignment, jobId, statusPayload, attempt) {
  const result = statusPayload?.result ?? {};
  const status = String(result.status ?? statusPayload?.status ?? '').toLowerCase();
  const ok = ['succeeded', 'success', 'done', 'complete', 'completed'].includes(status);
  return {
    ok,
    taskId: task.id,
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

function agentFor(session, agentInstanceId) {
  return [
    ...(session.agentRegistrySnapshot ?? []),
    ...(session.agents ?? []),
  ].find((agent) => agent?.agentInstanceId === agentInstanceId) ?? null;
}

function toolNameFor(session, serverName, baseName) {
  const tools = session.mcp?.[serverName]?.tools ?? [];
  const names = tools.map((tool) => String(tool.name ?? '')).filter(Boolean);
  return names.find((name) => name === baseName)
    ?? names.find((name) => name === `${serverName}__${baseName}`)
    ?? names.find((name) => name.endsWith(`__${baseName}`))
    ?? baseName;
}

function dispatch(session, store, type, event) {
  const dispatched = dispatchAgentEvent(session, createAgentEvent(type, event));
  store?.persistEvent?.(dispatched);
  return dispatched;
}

function workspaceFromSession(session) {
  return session.workspace ?? session._currentRunIdentity?.workspace ?? null;
}
