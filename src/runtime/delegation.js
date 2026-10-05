/**
 * Integrating a prepared delegation into a run.
 *
 * This code existed in one place: the `/run` handler, which received a
 * delegation prepared by `/delegate` and set it as a NEW run's plan. Hence
 * the blockage: an already-active conversational run called `/delegate` to
 * delegate its own decision, and the endpoint refused — rightly from its
 * point of view — because a run was already going. The run refused its own
 * delegation.
 *
 * Delegating is not starting a second run: it is moving the current run from
 * decision to execution. The loop already knows how — it switches to the
 * parallel scheduler as soon as a validated plan appears (`parallelHandoff`)
 * — it merely lacked a way to integrate the fragment without going out over
 * the network. That is what this function does, called both by `/run` (new
 * run) and from inside a run (internal delegation), with the same result and
 * the same run identity.
 */
import { integrate } from '../orchestrator/planIntegrator.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { emitRuntimeLog } from './supervisor.js';

/**
 * A delegation is auto-approved only on explicit opt-in: by default the run
 * waits for a human decision, and the `pending_approval` window must be
 * visible long enough for a UI to render it.
 */
export function resolvePreparedDelegationApproval({
  autoApprove = false,
  approvalManager = null,
  runId,
} = {}) {
  if (autoApprove !== true || typeof approvalManager?.approve !== 'function') {
    return { approved: false, awaitingApproval: true };
  }
  const result = approvalManager.approve({ scope: 'run', runId });
  return { approved: true, awaitingApproval: false, result };
}

/**
 * Does the run already carry an agent-validated plan?
 *
 * A structured task is recognised by its capability/operation pair: that is
 * what distinguishes it from a conversational plan step, which is only a
 * sentence. The criterion is `shouldUseParallelScheduler`'s, on purpose —
 * what triggers the switch and what forbids a second delegation must
 * designate the same object.
 */
export function hasStructuredPlan(session) {
  return (session?.headlessPlan ?? []).some((task) => task?.requiredCapability && task?.operation);
}

export function integratePreparedDelegation({
  session,
  store = null,
  runId,
  prepared,
  registry,
  approvalManager = null,
  autoApprove = false,
}) {
  if (!prepared?.fragment) throw new Error('Delegation carries no validated fragment.');
  const integrated = integrate(runId, prepared.fragment, {
    registry,
    session,
    store,
    workspace: session.workspace ?? null,
    enforceApprovalCoverage: true,
  });
  if (!integrated.ok) {
    throw new Error(`Delegated plan integration failed: ${(integrated.errors ?? [])
      .map((error) => error.message ?? error.code ?? String(error))
      .join('; ')}`);
  }
  emitRuntimeLog(
    session,
    `delegation: ${prepared.fragment.tasks.length} validated task(s) integrated from ${prepared.provider?.serverName ?? 'agent'}.agent_plan (${prepared.capability}/${prepared.operation})`,
  );
  /*
   Switch marker.

   The conversational loop could not guess that a structured plan had just
   appeared: it only looked at READY tasks, and a plan entirely waiting for
   approval counts none of them. It therefore concluded "nothing left to do",
   the evaluator judged the plan incomplete, the replanner relaunched a
   delegation — and five tasks became ten, then fifteen. The flag says what
   neither the ready-task count nor the status could say: a decision has just
   been made, the rest is no longer conversational.
  */
  session._structuredPlanIntegrated = true;
  const approval = resolvePreparedDelegationApproval({ autoApprove, approvalManager, runId });
  emitRuntimeLog(
    session,
    approval.approved
      ? `approval: run ${runId} auto-approved (autoApprove opt-in)`
      : `approval: run ${runId} awaiting explicit approval before mutations (/approve)`,
  );
  return { integrated, approval };
}

/**
 * Delegation from INSIDE the current run.
 *
 * Returns a summary meant for the model that called the tool. The returned
 * `runId` is the current run's, never a new one: that is the guarantee that
 * no second run was started on the side, and that is what the tests check.
 */
export async function delegateWithinRun(session, objective, {
  prepare,
  registry,
  store = null,
  approvalManager = null,
  autoApprove = false,
}) {
  const runId = session?._currentRunIdentity?.runId ?? null;
  if (!runId) throw new Error('No active run identity: in-run delegation requires a running run.');
  /*
   A run has only one plan.

   Defensive guard: if the loop calls the tool again while a structured plan
   is already in place, integrating a second fragment would duplicate the work
   instead of replacing it — that is exactly what was observed, five tasks
   becoming thirty-five. The refusal is explicit rather than silent: the model
   must read that it is asking again for something already done.
  */
  if (hasStructuredPlan(session)) {
    throw new Error('This run already carries a validated plan: it is executing, not deciding.');
  }
  const prepared = await prepare({ session, objective });
  const { approval } = integratePreparedDelegation({
    session,
    store,
    runId,
    prepared,
    registry,
    approvalManager,
    autoApprove,
  });
  // The validated plan is in place: the run's loop will see it on the next
  // turn and switch by itself to the parallel scheduler (parallelHandoff).
  dispatchAgentEvent(session, createAgentEvent('runtime_log', {
    origin: 'runtime',
    runId,
    payload: { message: `delegation: run ${runId} switched from decision to execution` },
  }));
  return {
    delegated: true,
    runId,
    awaitingApproval: approval.awaitingApproval === true,
    summary: prepared.summary ?? {
      agent: prepared.provider?.serverName ?? null,
      capability: prepared.capability ?? null,
      operation: prepared.operation ?? null,
      tasks: prepared.fragment.tasks.length,
    },
  };
}
