import { parseJsonText } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { formatMcpToolResult, callMcpTool as defaultCallMcpTool } from '../core/mcp.js';
import { capabilityRegistryForSession } from '../orchestrator/capabilityRegistry.js';
import { accept as acceptResult } from '../orchestrator/resultAggregator.js';
import { isSuccessful, isTerminal } from '../orchestrator/taskStatuses.js';

const ACTIVE_TASK_STATUSES = new Set(['running', 'queued', 'starting', 'assigned']);

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
    const runOutcomes = [];
    for (const task of activeTasks) {
      try {
        const outcome = await recoverTask({ store, session, run, task, callTool, resultAggregator });
        runOutcomes.push(outcome ?? null);
        if (outcome?.status === 'recovered') recovered.push(outcome);
        else if (outcome?.status === 'rescheduled') rescheduled.push(outcome);
        else if (outcome?.status === 'interrupted') interrupted.push(outcome);
      } catch (error) {
        errors.push({ runId: run.id, taskId: task.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // A run that recovery cannot move forward must be closed for good, or it
    // re-attaches as a blocking "a runtime run is already active" zombie on
    // every boot. This covers BOTH cases that can never resume on a fresh boot:
    //  - runs whose active tasks were all interrupted, and
    //  - runs with no active task to recover at all (e.g. left waiting for
    //    approval, or with only un-started pending tasks). Nothing here will
    //    ever progress, so finalize it now.
    const progressed = runOutcomes.some((outcome) => outcome?.status === 'recovered' || outcome?.status === 'rescheduled');
    if (!progressed) {
      const reason = activeTasks.length > 0
        ? 'Recovery found no recoverable task.'
        : 'Recovery found no active task to resume.';
      const changed = store.interruptRuns?.({ workspace: run.workspace ?? null, runId: run.id, reason }) ?? 0;
      if (changed > 0) {
        dispatch(session, store, 'runtime_log', {
          origin: 'recovery_manager',
          runId: run.id,
          workspace: run.workspace ?? workspaceFromSession(session),
          payload: { message: `recovery: run ${run.id} interrupted (${reason})` },
        });
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
  // A task whose capability no longer resolves can never be dispatched:
  // re-attaching it would recreate the forever-waiting queue it came from.
  // Fail it explicitly instead. No registry information at all (discovery
  // not run yet) keeps the current behavior.
  if (task.requiredCapability && !capabilityResolvable(session, task.requiredCapability)) {
    dispatch(session, store, 'plan_step_updated', {
      origin: 'recovery_manager',
      runId: run.id,
      taskId: task.id,
      workspace: run.workspace ?? workspaceFromSession(session),
      payload: {
        taskId: task.id,
        status: 'failed',
        recovery: {
          reason: 'unresolvable_capability',
          capability: task.requiredCapability,
        },
      },
    });
    return interruptTask({ store, session, run, task, reason: `unresolvable capability: ${task.requiredCapability}` });
  }

  const attempt = latestAttempt(store.listTaskAttempts?.({ taskId: task.id }) ?? []);
  const assignment = latestAssignment(store.listTaskAssignments?.({ taskId: task.id }) ?? [], attempt?.attemptId);
  if (!attempt?.jobId || !assignment?.agentInstanceId) {
    return interruptTask({ store, session, run, task, reason: 'missing attempt job or assignment' });
  }

  const agent = agentFor(session, assignment.agentInstanceId);
  if (agent?.providerKind === 'external-runtime' && typeof agent?.runtimeProvider?.status === 'function') {
    return recoverExternalRuntimeTask({ store, session, run, task, attempt, assignment, agent, resultAggregator });
  }
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

// An MCP job survives a manager restart on the agent's own side and reports
// its status through agent_status. An external-runtime job has no such
// side-channel here: the only way to check on it, or to give it up, is the
// same RuntimeProvider the dispatcher used to start it, re-resolved by
// agentInstanceId from the live registry rather than replayed from storage.
async function recoverExternalRuntimeTask({ store, session, run, task, attempt, assignment, agent, resultAggregator }) {
  const runtimeProvider = agent.runtimeProvider;
  let status;
  try {
    status = await runtimeProvider.status(attempt.jobId);
  } catch (error) {
    return interruptTask({
      store,
      session,
      run,
      task,
      reason: `external runtime status check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (isTerminal(status?.status)) {
    const result = {
      ok: isSuccessful(String(status?.status ?? '').toLowerCase()),
      taskId: task.id,
      attemptId: attempt.attemptId ?? null,
      jobId: attempt.jobId,
      agentInstanceId: assignment.agentInstanceId,
      status: status?.status,
      outputRefs: Array.isArray(status?.result?.outputRefs) ? status.result.outputRefs : [],
      metrics: status?.result?.metrics ?? {},
      // The gateway reports its failure at the TOP level of the status
      // payload ({ runId, status, error }), not inside `result` — same fix
      // already applied in dispatcher.js's taskResultFromStatus and
      // deepAgentsProvider.js's status().
      error: status?.result?.error ?? status?.error ?? null,
      rawStatus: status,
    };
    await resultAggregator(result, {
      session,
      runId: run.id,
      task,
      assignment: { agentInstanceId: assignment.agentInstanceId, serverName: null, agent },
      store,
      registry: capabilityRegistryForSession(session),
      workspaceConfig: session.wikircConfig ?? session.wikirc?.config ?? {},
    });
    return { status: 'recovered', runId: run.id, taskId: task.id, jobId: attempt.jobId };
  }

  // The runtime declares supportsIdempotency: false (runtimeProviders.js), so
  // a fresh invocation cannot be deduped against the one still running on the
  // external side. Requeuing it to `pending` like the MCP path below would
  // start a duplicate while the orphaned original keeps running/billing.
  // Cancel it explicitly instead of leaving it to run unattended.
  await runtimeProvider.cancel(attempt.jobId).catch(() => null);
  return interruptTask({
    store,
    session,
    run,
    task,
    reason: 'active external-runtime job cancelled on recovery (no idempotency support)',
  });
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


function capabilityResolvable(session, capability) {
  const registry = capabilityRegistryForSession(session);
  if (!registry || typeof registry.providersFor !== 'function') return true;
  // Only trust a registry that actually knows about capabilities. An empty
  // one (discovery not finished, or agents described without capability
  // lists) cannot distinguish "nothing provides X" from "no information".
  const snapshot = typeof registry.snapshot === 'function' ? registry.snapshot() : {};
  if (Object.keys(snapshot ?? {}).length === 0) return true;
  return registry.providersFor(capability).length > 0;
}

function parseToolPayload(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && !Array.isArray(result.content)) return result;
  return parseJsonText(formatMcpToolResult(result)) ?? {};
}

function taskResultFromStatus(task, assignment, jobId, statusPayload, attempt) {
  const result = statusPayload?.result ?? {};
  const status = String(result.status ?? statusPayload?.status ?? '').toLowerCase();
  const ok = isSuccessful(status);
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
    ...(session.runtimeProviderAgents ?? []),
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
