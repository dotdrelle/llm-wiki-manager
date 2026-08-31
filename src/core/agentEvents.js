import { normalizeActivity } from './activity.js';
import { attachActivityToExistingPlan, syncActivitiesToPlan } from './plan.js';
import { applyPlanPatch, normalizePlanPatch, normalizePlanRevision, rebasePlanPatch } from './planPatch.js';
import { formatRuntimeLogPayload, normalizeRuntimeLog, shortTaskLabel } from './runtimeLog.js';
import { projectSkillChains, TERMINAL as CONTROL_TERMINAL_STATUSES } from './skillChainView.js';
import { projectWorkflow } from './workflow.js';
import { validateContractInDev } from '../contracts/schemas.js';
import { isTerminal, isSuccessful, isUnknownStatus, normalizeTaskStatus } from '../orchestrator/taskStatuses.js';

const SESSION_PROJECTION_EVENTS = new Set([
  'run_started',
  'plan_set',
  'plan_step_updated',
  'control_message_received',
  'plan_patch_proposed',
  'plan_patch_approved',
  'plan_patch_applied',
  'plan_patch_rebased',
  'plan_patch_rejected',
  'plan.received',
  'plan.validated',
  'plan.rejected',
  'task_group.created',
  'task.created',
  'task.assigned',
  'task.started',
  'task.retry_scheduled',
  'task.result_returned',
  'task.completed',
  'task.failed',
  'plan.revision_changed',
  'activity_upserted',
  'run_evaluated',
  'run_replanned',
  'run_pending_approval',
  'run_approved',
  'tool_pending_approval',
  'tool_approved',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'control_enqueued',
  'control_started',
  'control_cancelled',
  'control_skipped',
  'agent.registered',
  'agent.health_changed',
  'run_done',
  'run_error',
  'run_cancelled',
  'runtime_log',
]);

// Events that can mutate state.plan in applyEvent() — only these warrant the
// before/after plan comparison below (runtime_log fires far more often and
// never touches the plan).
const PLAN_MUTATING_EVENTS = new Set([
  'run_started',
  'plan_set',
  'plan_patch_applied',
  'task.created',
  'plan_step_updated',
  'activity_upserted',
  'run_done',
]);

export function createAgentEvent(type, {
  origin = 'system',
  payload = {},
  runId = null,
  turnId = null,
  taskId = null,
  workspace = null,
} = {}) {
  return validateContractInDev('agentRunEvent', {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    type,
    origin,
    runId,
    turnId,
    taskId,
    workspace,
    payload,
  });
}

export function dispatchAgentEvent(session, event) {
  const normalized = withSessionRunIdentity(
    event.id && event.ts ? event : createAgentEvent(event.type, event),
    session,
  );
  validateContractInDev('agentRunEvent', normalized);
  const tracksPlan = PLAN_MUTATING_EVENTS.has(normalized.type);
  const previousPlan = tracksPlan ? JSON.stringify(session.headlessPlan ?? null) : null;
  session.agentEvents ??= [];
  session.agentEvents.push(normalized);
  session._agentProjectionState ??= createProjectionState();
  applyEvent(session._agentProjectionState, normalized);
  session.agentProjection = publicProjection(session._agentProjectionState);
  if (SESSION_PROJECTION_EVENTS.has(normalized.type)) {
    applyAgentProjectionToSession(session, session.agentProjection);
    if (tracksPlan && JSON.stringify(session.headlessPlan ?? null) !== previousPlan) {
      session._onPlanUpdate?.();
    }
  }
  session._onAgentEvent?.(normalized, session.agentProjection);
  return normalized;
}

// Shared `runtime_log` shaping — was independently reimplemented byte-for-byte
// in runtime/supervisor.js, orchestrator/agentRegistry.js and
// orchestrator/providers/runtimeProviders.js (each citing the same "avoid a
// cycle with supervisor.js" reason, even where no such cycle existed). This
// module already sits below all three, so it is the one safe common home.
export function dispatchRuntimeLog(session, message) {
  if (!session) return;
  const payload = normalizeRuntimeLog(message, { session });
  return dispatchAgentEvent(session, createAgentEvent('runtime_log', {
    origin: 'runtime',
    runId: payload.runId ?? null,
    taskId: payload.taskId ?? null,
    workspace: payload.workspaceId ?? null,
    payload,
  }));
}

// Full in-memory projection reset for a session. The runtime keeps the live
// projection in memory (session.agentProjection) and serves it from /state, so
// interrupting runs is not enough to clear the PLAN/ACTIVITY/LOGS panels — the
// projection has to be emptied here too. Pair with store.clearWorkspaceState so
// the reset also survives a reboot (otherwise hydrateSession replays it back).
export function resetSessionProjection(session) {
  if (!session || typeof session !== 'object') return;
  session.agentEvents = [];
  session._agentProjectionState = createProjectionState();
  session.agentProjection = publicProjection(session._agentProjectionState);
  applyAgentProjectionToSession(session, session.agentProjection);
  session.jobQueue = [];
  session._onPlanUpdate?.();
}

function withSessionRunIdentity(event, session) {
  const identity = session?._currentRunIdentity;
  // The workspace must be attached even OUTSIDE a run identity: the SSE
  // publisher drops events whose workspace does not match the (always
  // workspace-scoped) serve UI client. Events dispatched between chained
  // executions — e.g. the plan_set of the next action, run evaluation,
  // assistant messages — used to leave with workspace=null and never reached
  // the UI, which then displayed a stale plan from the previous action.
  const workspace = event.workspace ?? identity?.workspace ?? session?.workspace ?? null;
  if (event.payload?.independent === true) {
    return { ...event, runId: null, turnId: event.turnId ?? null, taskId: event.taskId ?? null, workspace };
  }
  if (!identity) {
    return workspace === (event.workspace ?? null) ? event : { ...event, workspace };
  }
  return {
    ...event,
    runId: event.runId ?? identity.runId ?? null,
    turnId: event.turnId ?? identity.turnId ?? null,
    taskId: event.taskId ?? identity.taskId ?? null,
    workspace,
  };
}

export function reduceAgentEvents(events = []) {
  const state = createProjectionState();

  for (const event of events) {
    applyEvent(state, event);
  }

  return publicProjection(state);
}

// Maps every projected conversation entry back to the sequence of the event
// that produced it. The conversation is derived from the event log, never
// stored, so "delete everything below this question" can only be expressed as
// "delete every event after the one that appended it". Replays the same
// applyEvent used by reduceAgentEvents, so the mapping cannot drift from the
// projection it describes.
export function conversationEventSequences(events = []) {
  const state = createProjectionState();
  const sequences = [];
  for (const event of events) {
    applyEvent(state, event);
    const sequence = Number.isFinite(Number(event?.sequence)) ? Number(event.sequence) : null;
    // Streaming deltas mutate the last entry in place instead of appending, so
    // an entry keeps the sequence of the event that first created it.
    while (sequences.length < state.conversation.length) sequences.push(sequence);
    if (sequences.length > state.conversation.length) sequences.length = state.conversation.length;
  }
  return sequences;
}

function createProjectionState() {
  return {
    conversation: [],
    chain: [],
    plan: null,
    activities: {},
    logs: [],
    evaluation: null,
    replans: [],
    approvals: [],
    planRevision: 0,
    planPatches: [],
    controlQueue: [],
    agents: {},
    summary: null,
    status: 'idle',
  };
}

function publicProjection(state) {
  const projection = {
    conversation: state.conversation.map((message) => ({ ...message })),
    chain: state.chain.map((step) => ({ ...step })),
    plan: state.plan ? state.plan.map((step) => ({ ...step })) : null,
    activities: sortedActivities(state.activities).map((activity) => ({ ...activity })),
    logs: [...state.logs],
    evaluation: state.evaluation ? { ...state.evaluation } : null,
    replans: state.replans.map((replan) => ({ ...replan, plan: [...(replan.plan ?? [])] })),
    approvals: state.approvals.map((approval) => ({ ...approval })),
    planRevision: state.planRevision,
    planPatches: state.planPatches.map((patch) => ({
      ...patch,
      operations: (patch.operations ?? []).map((operation) => ({ ...operation })),
      patch: patch.patch ? { ...patch.patch, operations: (patch.patch.operations ?? []).map((operation) => ({ ...operation })) } : null,
    })),
    controlQueue: state.controlQueue.map((item) => ({ ...item })),
    // LOT G: the chain is a projection, never stored state.
    skillChains: projectSkillChains(state.controlQueue),
    agents: Object.values(state.agents)
      .map((agent) => ({ ...agent, description: cloneJson(agent.description) }))
      .sort((a, b) => a.agentInstanceId.localeCompare(b.agentInstanceId)),
    summary: state.summary,
    status: state.status,
  };
  return {
    ...projection,
    workflow: projectWorkflow(projection),
  };
}

export function applyAgentProjectionToSession(session, projection) {
  session.headlessPlan = projection.plan ? projection.plan.map((step) => ({ ...step })) : null;
  session.activities = Object.fromEntries((projection.activities ?? []).map((activity) => [activity.key, { ...activity }]));
  session.controlQueue = (projection.controlQueue ?? []).map((item) => ({ ...item }));
  session.skillChains = (projection.skillChains ?? []).map((chain) => ({
    ...chain,
    steps: chain.steps.map((step) => ({ ...step })),
  }));
  session.agents = (projection.agents ?? []).map((agent) => ({ ...agent, description: cloneJson(agent.description) }));
  session.planRevision = projection.planRevision ?? 0;
  session.planPatches = (projection.planPatches ?? []).map((patch) => ({ ...patch }));
  session.workflow = projection.workflow ? { ...projection.workflow } : null;
  const production = (projection.activities ?? []).filter((activity) => activity.source === 'production').at(-1);
  session.productionActivity = production ? {
    jobId: production.id,
    status: production.status,
    label: production.label,
    terminal: production.terminal,
    updatedAt: production.updatedAt,
  } : session.productionActivity ?? null;
}

function applyEvent(state, event) {
  switch (event.type) {
    case 'run_started':
      // Only a real runtime run (origin 'runtime') marks the projection
      // 'running'. An interactive turn (origin 'user') is NOT a run: forcing
      // 'running' here made the graph classify activeRun=true and hide Donna's
      // MCP read tools (cme_status, wiki_workspace_status…), so questions about
      // MCP state failed. Preserve the existing status (idle, or a genuinely
      // active runtime run synced from the runtime) for interactive turns.
      if (event.origin === 'runtime') state.status = 'running';
      state.plan = null;
      state.chain = [];
      state.activities = {};
      state.logs = [];
      state.evaluation = null;
      state.replans = [];
      state.approvals = [];
      state.planRevision = 0;
      state.planPatches = [];
      state.summary = null;
      pruneTerminalControlItems(state.controlQueue);
      return;
    case 'user_message':
      state.conversation.push({ role: 'user', content: String(event.payload?.content ?? '') });
      return;
    case 'assistant_message':
      finalizeAssistantMessage(state, String(event.payload?.content ?? ''));
      return;
    case 'assistant_delta':
      appendAssistantDelta(state, String(event.payload?.delta ?? ''));
      return;
    case 'assistant_delta_reset':
      discardStreamingAssistantMessage(state);
      return;
    case 'tool_call_started':
      state.chain.push({
        type: 'tool',
        status: 'running',
        callId: event.payload?.callId ?? null,
        name: event.payload?.name ?? null,
        args: event.payload?.args ?? null,
        summary: event.payload?.summary ?? 'calling...',
      });
      return;
    case 'tool_call_result':
      finishToolCall(state, event.payload);
      return;
    case 'activity_upserted':
      upsertActivity(state, event.payload?.activity);
      return;
    case 'plan_set':
      state.plan = normalizePlan(event.payload?.steps, event.payload ?? {});
      // A plan_set always replaces the plan wholesale (initial declaration,
      // fallback extraction, or a full replan) — bump the revision so any
      // patch proposed against the prior plan is detected as stale and
      // rebased instead of silently applying against a structure that no
      // longer matches what it was built for. An explicit payload.planRevision
      // still wins, for callers that manage revisions themselves.
      state.planRevision = event.payload?.planRevision != null
        ? normalizePlanRevision(event.payload.planRevision)
        : state.planRevision + 1;
      return;
    case 'plan.received':
      appendLog(state, `${logTime(event.ts)} Plan received for run ${String(event.runId ?? event.payload?.runId ?? '')}`.trim());
      return;
    case 'plan.validated':
      appendLog(state, `${logTime(event.ts)} Plan validated for run ${String(event.runId ?? event.payload?.runId ?? '')}`.trim());
      return;
    case 'plan.rejected':
      appendLog(state, `${logTime(event.ts)} Plan rejected: ${formatPlanErrors(event.payload?.errors)}`.trim());
      return;
    case 'task_group.created':
      return;
    case 'task.created':
      appendCreatedTask(state, event.payload?.task);
      return;
    case 'task.assigned':
      appendLog(state, taskLogLine(state, event, 'assigned'));
      return;
    case 'task.started':
      // Silent: always follows `task.assigned` (same task, milliseconds apart),
      // which already printed the "started" line.
      return;
    case 'task.retry_scheduled':
      appendLog(state, taskLogLine(state, event, 'retry'));
      return;
    case 'task.result_returned':
      // Silent: an internal transition immediately followed by
      // `task.completed`/`task.failed`, which carry the same result.
      return;
    case 'task.completed':
      appendLog(state, taskLogLine(state, event, 'completed'));
      return;
    case 'task.failed':
      appendLog(state, taskLogLine(state, event, 'failed'));
      return;
    case 'plan.revision_changed':
      if (Array.isArray(event.payload?.tasks)) {
        state.plan = normalizePlan(event.payload.tasks, { owner: 'orchestrator', planRevision: state.planRevision });
      }
      state.planRevision = normalizePlanRevision(event.payload?.planRevision ?? state.planRevision + 1);
      return;
    case 'plan_step_updated':
      {
        // L'anomalie remonte par la valeur de retour plutôt que par une
        // référence au state : `updatePlanStep` reste une fonction sur un
        // plan, et le journal reste la responsabilité de l'appelant.
        const anomaly = updatePlanStep(state.plan, event.payload ?? {});
        if (anomaly) appendLog(state, `${logTime(event.ts)} ${anomaly}`.trim());
      }
      return;
    case 'control_message_received':
      appendLog(state, `${logTime(event.ts)} Control message: ${String(event.payload?.input ?? '')}`.trim());
      return;
    case 'plan_patch_proposed':
      upsertPlanPatch(state, {
        id: patchIdFromEvent(event),
        status: 'proposed',
        runId: event.runId ?? event.payload?.targetRunId ?? null,
        workspace: event.workspace ?? null,
        input: event.payload?.input ?? null,
        patch: normalizePlanPatch(event.payload?.patch ?? {}, {
          targetRunId: event.runId ?? event.payload?.targetRunId ?? null,
          basePlanRevision: state.planRevision,
        }),
        createdAt: event.ts,
        updatedAt: event.ts,
      });
      return;
    case 'plan_patch_approved':
      upsertPlanPatch(state, {
        id: patchIdFromEvent(event),
        status: 'approved',
        approvedAt: event.ts,
        updatedAt: event.ts,
      });
      return;
    case 'plan_patch_rebased': {
      const existing = state.planPatches.find((patch) => patch.id === patchIdFromEvent(event));
      const rebased = normalizePlanPatch(event.payload?.patch ?? rebasePlanPatch(existing?.patch ?? {}, { currentRevision: state.planRevision }), {
        targetRunId: event.runId ?? null,
        basePlanRevision: state.planRevision,
      });
      upsertPlanPatch(state, {
        id: patchIdFromEvent(event),
        status: 'rebased',
        patch: rebased,
        updatedAt: event.ts,
      });
      return;
    }
    case 'plan_patch_applied': {
      const patchId = patchIdFromEvent(event);
      const patch = normalizePlanPatch(event.payload?.patch ?? {}, {
        targetRunId: event.runId ?? event.payload?.targetRunId ?? null,
        basePlanRevision: state.planRevision,
      });
      const applied = applyPlanPatch(state.plan, patch, { currentRevision: state.planRevision });
      if (!applied.ok) {
        upsertPlanPatch(state, {
          id: patchId,
          status: 'rejected',
          rejectionReason: applied.reason,
          currentRevision: applied.currentRevision,
          updatedAt: event.ts,
        });
        return;
      }
      state.plan = applied.plan;
      state.planRevision = applied.planRevision;
      upsertPlanPatch(state, {
        id: patchId,
        status: 'applied',
        patch,
        appliedAt: event.ts,
        planRevision: state.planRevision,
        updatedAt: event.ts,
      });
      return;
    }
    case 'plan_patch_rejected':
      upsertPlanPatch(state, {
        id: patchIdFromEvent(event),
        status: 'rejected',
        rejectionReason: event.payload?.reason ?? null,
        updatedAt: event.ts,
      });
      return;
    case 'run_summary':
      state.summary = String(event.payload?.content ?? '');
      if (state.summary) state.conversation.push({ role: 'assistant', content: state.summary });
      return;
    case 'run_evaluated':
      state.evaluation = {
        ok: event.payload?.ok === true,
        reason: String(event.payload?.reason ?? ''),
        suggestedAction: event.payload?.suggestedAction ?? null,
        runId: event.runId ?? event.payload?.runId ?? null,
      };
      return;
    case 'run_replanned':
      state.replans.push({
        reason: String(event.payload?.reason ?? ''),
        plan: Array.isArray(event.payload?.plan) ? event.payload.plan.map(String) : [],
        replansLeft: Number(event.payload?.replansLeft ?? 0),
        runId: event.runId ?? event.payload?.runId ?? null,
      });
      return;
    case 'run_pending_approval':
    case 'tool_pending_approval':
      upsertApproval(state, {
        id: event.payload?.approvalId ?? event.payload?.runId ?? event.payload?.itemId ?? event.id,
        scope: event.type === 'run_pending_approval' ? 'run' : 'tool',
        status: 'pending_approval',
        runId: event.runId ?? event.payload?.runId ?? null,
        itemId: event.payload?.itemId ?? null,
        reason: event.payload?.reason ?? null,
        tool: event.payload?.tool ?? null,
        plan: event.payload?.plan ?? null,
        createdAt: event.ts,
      });
      return;
    case 'run_approved':
    case 'tool_approved':
      upsertApproval(state, {
        id: event.payload?.approvalId ?? event.payload?.runId ?? event.payload?.itemId ?? event.id,
        scope: event.type === 'run_approved' ? 'run' : 'tool',
        status: 'approved',
        runId: event.runId ?? event.payload?.runId ?? null,
        itemId: event.payload?.itemId ?? null,
        approvedAt: event.ts,
      });
      return;
    case 'approval.requested':
      upsertApproval(state, {
        id: approvalProjectionId(event),
        approvalId: event.payload?.approvalId ?? event.payload?.id ?? null,
        scope: event.payload?.scope ?? 'task',
        status: 'pending_approval',
        runId: event.runId ?? event.payload?.runId ?? null,
        workspaceId: event.workspace ?? event.payload?.workspaceId ?? event.payload?.workspace ?? null,
        planRevision: event.payload?.planRevision ?? null,
        taskId: event.taskId ?? event.payload?.taskId ?? null,
        itemId: event.payload?.itemId ?? event.payload?.taskId ?? null,
        groupId: event.payload?.groupId ?? null,
        approvalClasses: normalizeApprovalClasses(event.payload?.approvalClasses ?? event.payload?.approvalClass),
        reason: event.payload?.reason ?? null,
        createdAt: event.ts,
      });
      return;
    case 'approval.granted': {
      const grant = {
        id: approvalProjectionId(event),
        approvalId: event.payload?.approvalId ?? event.payload?.id ?? null,
        scope: event.payload?.scope ?? 'run',
        status: 'approved',
        runId: event.runId ?? event.payload?.runId ?? null,
        workspaceId: event.workspace ?? event.payload?.workspaceId ?? event.payload?.workspace ?? null,
        planRevision: event.payload?.planRevision ?? null,
        taskId: event.taskId ?? event.payload?.taskId ?? null,
        itemId: event.payload?.itemId ?? event.payload?.taskId ?? null,
        groupId: event.payload?.groupId ?? null,
        approvalClasses: normalizeApprovalClasses(event.payload?.approvalClasses ?? event.payload?.approvalClass),
        reason: event.payload?.reason ?? null,
        approvedAt: event.ts,
      };
      upsertApproval(state, grant);
      markCoveredApprovalsApproved(state.approvals, grant, event.ts);
      return;
    }
    case 'approval.rejected':
      upsertApproval(state, {
        id: approvalProjectionId(event),
        approvalId: event.payload?.approvalId ?? event.payload?.id ?? null,
        scope: event.payload?.scope ?? 'run',
        status: 'rejected',
        runId: event.runId ?? event.payload?.runId ?? null,
        workspaceId: event.workspace ?? event.payload?.workspaceId ?? event.payload?.workspace ?? null,
        planRevision: event.payload?.planRevision ?? null,
        taskId: event.taskId ?? event.payload?.taskId ?? null,
        itemId: event.payload?.itemId ?? event.payload?.taskId ?? null,
        groupId: event.payload?.groupId ?? null,
        approvalClasses: normalizeApprovalClasses(event.payload?.approvalClasses ?? event.payload?.approvalClass),
        reason: event.payload?.reason ?? null,
        rejectedAt: event.ts,
      });
      return;
    case 'run_done':
      state.status = 'done';
      finishPendingPlanSteps(state.plan);
      finishControlByRun(state.controlQueue, event.runId ?? event.payload?.runId ?? null, 'done', event.ts);
      return;
    case 'run_cancelled':
      state.status = 'cancelled';
      appendLog(state, `${logTime(event.ts)} ${String(event.payload?.message ?? 'Agent run cancelled.')}`.trim());
      // A cancelled run must not leave its plan steps "running/pending" and
      // its activities spinning in the panels: mark every non-terminal one
      // cancelled so the display reflects reality immediately.
      cancelPendingPlanSteps(state.plan);
      cancelActiveActivities(state.activities, event.ts);
      cancelPendingApprovals(state.approvals, event.runId ?? event.payload?.runId ?? null, event.ts);
      finishControlByRun(state.controlQueue, event.runId ?? event.payload?.runId ?? null, 'cancelled', event.ts);
      return;
    case 'run_error':
      state.status = 'error';
      /*
       "Run failed:" is part of the line, not decoration.

       The serve journal keeps only the entries matching a keyword list
       (failed, error, done, approval…). A run killed by a message that uses
       none of those words — "No agent provides capability workspace.restore."
       — was therefore filtered out as unimportant, and the panel showed "No
       essential run event yet" over a run that had just died with its reason
       already in hand. What ends a run is essential by construction; the
       prefix states that instead of hoping the wording says so.
      */
      appendLog(state, `${logTime(event.ts)} Run failed: ${String(event.payload?.message ?? 'Agent run failed.')}`.trim());
      // A dead run must not leave "pending" plan steps and spinning
      // activities in the persisted projection: they reappeared as ghosts
      // at every relaunch ("des trucs dans le plan qui n'existent pas") and
      // /kill honestly reported 0 because nothing was actually running.
      cancelPendingPlanSteps(state.plan);
      cancelActiveActivities(state.activities, event.ts);
      cancelPendingApprovals(state.approvals, event.runId ?? event.payload?.runId ?? null, event.ts);
      finishControlByRun(state.controlQueue, event.runId ?? event.payload?.runId ?? null, 'failed', event.ts);
      return;
    case 'control_enqueued':
      upsertControlItem(state.controlQueue, {
        id: event.payload?.id ?? event.id,
        workspace: event.workspace ?? event.payload?.workspace ?? null,
        input: String(event.payload?.input ?? ''),
        status: 'queued',
        createdAt: event.payload?.createdAt ?? event.ts,
        updatedAt: event.ts,
        ...(event.payload?.capabilityPlan !== undefined ? { capabilityPlan: event.payload.capabilityPlan } : {}),
        ...(event.payload?.chainId ? { chainId: event.payload.chainId } : {}),
        ...(event.payload?.skillName ? { skillName: event.payload.skillName } : {}),
        ...(event.payload?.skillExecution ? { skillExecution: event.payload.skillExecution } : {}),
        /*
         La pile des compétences ouvertes au-dessus de cet élément.

         Elle DOIT survivre à la projection : c'est le seul état qui relie un
         run imbriqué à ses ancêtres. Le run n'est pas exécuté en ligne — il est
         mis en file et démarre après que son parent s'est nettoyé — donc rien
         d'autre que l'élément lui-même ne peut la lui transmettre. La perdre
         ici, c'est rouvrir A→B→A en silence.
        */
        ...(Array.isArray(event.payload?.skillStack) && event.payload.skillStack.length
          ? { skillStack: [...event.payload.skillStack] }
          : {}),
        ...(event.payload?.selectionKind ? { selectionKind: event.payload.selectionKind } : {}),
        ...(Number.isInteger(event.payload?.chainSequence) ? { chainSequence: event.payload.chainSequence } : {}),
        optional: event.payload?.optional === true,
        continueOnFailure: event.payload?.continueOnFailure === true,
      });
      return;
    case 'control_started':
      upsertControlItem(state.controlQueue, {
        id: event.payload?.id ?? null,
        runId: event.runId ?? event.payload?.runId ?? null,
        status: 'running',
        startedAt: event.payload?.startedAt ?? event.ts,
        updatedAt: event.ts,
      });
      return;
    case 'control_cancelled':
      upsertControlItem(state.controlQueue, {
        id: event.payload?.id ?? null,
        status: 'cancelled',
        finishedAt: event.payload?.finishedAt ?? event.ts,
        updatedAt: event.ts,
      });
      return;
    case 'control_skipped':
      upsertControlItem(state.controlQueue, {
        id: event.payload?.id ?? null,
        status: 'skipped',
        skipReason: event.payload?.reason ?? null,
        finishedAt: event.payload?.finishedAt ?? event.ts,
        updatedAt: event.ts,
      });
      return;
    case 'agent.registered':
      upsertAgent(state, event.payload?.agent, event.ts);
      return;
    case 'agent.health_changed':
      upsertAgent(state, {
        ...(event.payload?.agent ?? {}),
        agentInstanceId: event.payload?.agentInstanceId ?? event.payload?.agent?.agentInstanceId,
        health: event.payload?.health ?? event.payload?.agent?.health,
      }, event.ts);
      return;
    case 'runtime_log':
      appendLog(state, formatRuntimeLogPayload(event.payload ?? {}, event.ts));
      return;
    default:
      return;
  }
}

function upsertAgent(state, rawAgent, ts) {
  if (!rawAgent?.agentInstanceId) return;
  const existing = state.agents[rawAgent.agentInstanceId] ?? {};
  state.agents[rawAgent.agentInstanceId] = {
    ...existing,
    ...rawAgent,
    description: cloneJson(rawAgent.description ?? existing.description ?? null),
    health: rawAgent.health ?? rawAgent.description?.health?.status ?? existing.health ?? 'unavailable',
    lastSeenAt: rawAgent.lastSeenAt ?? ts,
  };
}

function upsertById(list, next) {
  const index = list.findIndex((item) => item.id === next.id);
  if (index === -1) {
    list.push(next);
    return;
  }
  list[index] = {
    ...list[index],
    ...next,
  };
}

function upsertControlItem(queue, next) {
  if (!next.id) return;
  upsertById(queue, next);
}

function upsertPlanPatch(state, next) {
  if (!next.id) return;
  upsertById(state.planPatches, next);
}

function appendCreatedTask(state, rawTask) {
  if (!rawTask?.id) return;
  state.plan ??= [];
  const existing = state.plan.find((task) => String(task.id ?? task.step) === String(rawTask.id));
  if (existing) return;
  state.plan.push(normalizePlanTask(rawTask, state.plan.length, { owner: 'orchestrator' }));
}

function patchIdFromEvent(event) {
  return event.payload?.id ?? event.payload?.patchId ?? event.id;
}

function finishControlByRun(queue, runId, status, finishedAt) {
  if (!runId) return;
  const item = queue.find((entry) => entry.runId === runId && entry.status === 'running');
  if (!item) return;
  item.status = status;
  item.finishedAt = finishedAt;
  item.updatedAt = finishedAt;
}

/*
 A new run makes the previous control items history.

 `run_started` already resets plan, activities and logs, but the control queue
 was left to accumulate: a cancelled or failed chain stayed in the CHAIN panel
 across the next plan, and its terminal items kept counting in the queue ("Queue
 (14)" over 4 live items). Prune here, not in the UI, so both projections agree.

 A chain is dropped only once EVERY item is terminal — the active chain always
 has a running/queued item and is therefore never pruned mid-flight. Standalone
 control items (no chainId) are dropped as soon as they are terminal.
*/
function pruneTerminalControlItems(queue) {
  const byChain = new Map();
  const standalone = [];
  for (const item of queue) {
    if (item.chainId) {
      if (!byChain.has(item.chainId)) byChain.set(item.chainId, []);
      byChain.get(item.chainId).push(item);
    } else {
      standalone.push(item);
    }
  }
  const drop = new Set();
  for (const items of byChain.values()) {
    if (items.every((item) => CONTROL_TERMINAL_STATUSES.has(String(item.status ?? '').toLowerCase()))) {
      for (const item of items) drop.add(item.id);
    }
  }
  for (const item of standalone) {
    if (CONTROL_TERMINAL_STATUSES.has(String(item.status ?? '').toLowerCase())) drop.add(item.id);
  }
  if (!drop.size) return;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (drop.has(queue[i].id)) queue.splice(i, 1);
  }
}

function appendAssistantDelta(state, delta) {
  if (!delta) return;
  const last = state.conversation.at(-1);
  if (last?.role === 'assistant' && last.streaming) {
    last.content += delta;
  } else {
    state.conversation.push({ role: 'assistant', content: delta, streaming: true });
  }
}

/*
 Jeter une réponse en cours d'écriture, sans retirer son entrée.

 Une itération de la boucle d'outils peut produire du texte puis décider
 d'appeler un outil : ce texte est un raisonnement intermédiaire que le tour
 suivant remplace, il ne doit pas rester à l'écran.

 L'entrée est vidée, jamais dépilée. La réconciliation de `serve`
 (`chatHtml.ts`) suppose une conversation en ajout seul — « le serveur ne mute
 que la dernière entrée, tout ce qui précède est acquis » — et n'indexe la
 boucle que sur la longueur croissante. Un `pop` la ferait passer sous le
 nombre de références déjà rendues : l'élément DOM en trop resterait affiché
 avec le texte qu'on voulait justement effacer, et tous les messages suivants
 se décaleraient d'un cran.
*/
function discardStreamingAssistantMessage(state) {
  const last = state.conversation.at(-1);
  if (last?.role === 'assistant' && last.streaming) last.content = '';
}

function finalizeAssistantMessage(state, content) {
  const last = state.conversation.at(-1);
  if (last?.role === 'assistant' && last.streaming) {
    last.content = content || last.content;
    delete last.streaming;
    return;
  }
  if (content) state.conversation.push({ role: 'assistant', content });
}

function finishToolCall(state, payload = {}) {
  const callId = payload.callId ?? null;
  const existing = callId ? state.chain.find((step) => step.callId === callId) : null;
  const step = existing ?? {
    type: 'tool',
    callId,
    name: payload.name ?? null,
  };
  step.status = payload.ok === false ? 'failed' : 'done';
  step.result = payload.result ?? null;
  step.summary = payload.summary ?? step.summary ?? step.status;
  if (!existing) state.chain.push(step);
}

function upsertApproval(state, next) {
  upsertById(state.approvals, next);
}

function approvalProjectionId(event) {
  return event.payload?.id
    ?? event.payload?.approvalId
    ?? event.payload?.taskId
    ?? event.payload?.itemId
    ?? event.payload?.groupId
    ?? event.payload?.runId
    ?? event.id;
}

function normalizeApprovalClasses(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function markCoveredApprovalsApproved(approvals, grant, ts) {
  const classes = normalizeApprovalClasses(grant.approvalClasses);
  for (const approval of approvals) {
    if (approval.status !== 'pending_approval') continue;
    if (grant.runId != null && approval.runId != null && String(grant.runId) !== String(approval.runId)) continue;
    if (grant.workspaceId != null && approval.workspaceId != null && String(grant.workspaceId) !== String(approval.workspaceId)) continue;
    if (grant.planRevision != null && approval.planRevision != null && Number(grant.planRevision) !== Number(approval.planRevision)) continue;
    const approvalClasses = normalizeApprovalClasses(approval.approvalClasses);
    if (classes.length > 0 && approvalClasses.length > 0 && !approvalClasses.some((item) => classes.includes(item))) continue;
    if (grant.scope === 'group' && String(grant.groupId ?? '') !== String(approval.groupId ?? '')) continue;
    if (grant.scope === 'task' || grant.scope === 'tool') {
      const grantIds = new Set([grant.taskId, grant.itemId, grant.approvalId, grant.id].filter(Boolean).map(String));
      const approvalIds = [approval.taskId, approval.itemId, approval.approvalId, approval.id].filter(Boolean).map(String);
      if (!approvalIds.some((id) => grantIds.has(id))) continue;
    }
    approval.status = 'approved';
    approval.approvedAt = ts;
  }
}

function cancelPendingPlanSteps(plan) {
  for (const step of plan ?? []) {
    if (!isTerminal(step.status)) step.status = 'cancelled';
  }
}

function cancelPendingApprovals(approvals, runId, ts) {
  for (const approval of approvals ?? []) {
    if (approval.status !== 'pending_approval') continue;
    if (runId != null && approval.runId != null && String(approval.runId) !== String(runId)) continue;
    approval.status = 'cancelled';
    approval.cancelledAt = ts;
  }
}

function cancelActiveActivities(activities, ts) {
  for (const activity of Object.values(activities ?? {})) {
    if (activity && activity.terminal !== true) {
      activity.status = 'cancelled';
      activity.terminal = true;
      activity.updatedAt = ts ?? activity.updatedAt;
    }
  }
}

function finishPendingPlanSteps(plan) {
  for (const step of plan ?? []) {
    if (step.status === 'running' || step.status === 'pending') {
      step.status = 'done';
    }
  }
}

function upsertActivity(state, rawActivity) {
  const activity = normalizeActivity(rawActivity);
  if (!activity) return;
  state.activities[activity.key] = {
    ...(state.activities[activity.key] ?? {}),
    ...activity,
  };
  ensurePlanFromActivityProjection(state, activity);
  syncActivitiesToPlan(state.plan, sortedActivities(state.activities));
}

function ensurePlanFromActivityProjection(state, activity) {
  const actKey = activity.key ?? null;
  if (state.plan?.some((step) => step.owner === 'orchestrator')) {
    attachActivityToExistingPlan(state.plan, activity);
    return;
  }
  if (state.plan && actKey !== null && state.plan[0]?._activityKey === actKey) return;
  const steps = activity.plan?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    state.plan = steps.map((step, i) => ({
      step: i + 1,
      id: step.id ?? null,
      description: step.label,
      status: 'pending',
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
      executor: step.executor ?? null,
      executorQuery: step.executorQuery ?? null,
      outputRefs: Array.isArray(step.outputRefs) ? step.outputRefs.map(String) : [],
      owner: 'activity',
      ownerActivityKey: activity.key,
      _activityKey: activity.key,
    }));
    return;
  }
  state.plan = [{
    step: 1,
    id: null,
    description: activity.label,
    status: 'pending',
    dependsOn: [],
    executor: null,
    executorQuery: null,
    outputRefs: [],
    owner: 'activity',
    ownerActivityKey: activity.key,
    _activityKey: activity.key,
  }];
}

function normalizePlan(steps, payload = {}) {
  if (!Array.isArray(steps)) return null;
  const owner = payload.owner ?? 'orchestrator';
  const ownerActivityKey = payload.ownerActivityKey ?? payload.activityKey ?? null;
  const plan = steps.map((raw, i) => normalizePlanTask(raw, i, { owner, ownerActivityKey, activityKey: payload.activityKey ?? null }));
  return validateContractInDev('plan', plan);
}

function normalizePlanTask(raw, index, { owner = 'orchestrator', ownerActivityKey = null, activityKey = null } = {}) {
  const item = typeof raw === 'string' ? { description: raw } : (raw ?? {});
  const task = {
    step: Number(item.step ?? index + 1),
    id: item.id ?? null,
    label: item.label ?? item.description ?? item.name ?? `Step ${index + 1}`,
    description: String(item.description ?? item.label ?? item.name ?? `Step ${index + 1}`),
    status: item.status ?? 'pending',
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
    requiredCapability: item.requiredCapability ?? null,
    operation: item.operation ?? null,
    arguments: item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? { ...item.arguments } : {},
    groupId: item.groupId ?? null,
    dependsOnGroup: item.dependsOnGroup ?? null,
    barrier: item.barrier === true,
    parallelizable: item.parallelizable === true,
    recommendedConcurrency: item.recommendedConcurrency,
    inputRefs: Array.isArray(item.inputRefs) ? item.inputRefs.map(cloneRef) : [],
    expectedOutputRefs: Array.isArray(item.expectedOutputRefs) ? item.expectedOutputRefs.map(cloneRef) : [],
    executor: item.executor ?? null,
    executorQuery: item.executorQuery ?? null,
    outputRefs: Array.isArray(item.outputRefs) ? item.outputRefs.map(String) : [],
    locks: Array.isArray(item.locks) ? item.locks.map(String) : [],
    requiresApproval: item.requiresApproval === true,
    approvalClass: item.approvalClass ?? null,
    approvalSummary: item.approvalSummary ?? null,
    idempotencyKey: item.idempotencyKey ?? null,
    progressWeight: Number.isFinite(Number(item.progressWeight)) ? Number(item.progressWeight) : 1,
    priority: item.priority,
    retryPolicy: item.retryPolicy ? cloneJson(item.retryPolicy) : undefined,
    retryState: item.retryState ? cloneJson(item.retryState) : undefined,
    retryAssignment: item.retryAssignment ? cloneJson(item.retryAssignment) : undefined,
    writeLocks: Array.isArray(item.writeLocks) ? item.writeLocks.map(String) : item.writeLocks ?? null,
    deliverableWrites: Array.isArray(item.deliverableWrites) ? item.deliverableWrites.map(String) : [],
    wikiPageWrites: Array.isArray(item.wikiPageWrites) ? item.wikiPageWrites.map(String) : [],
    workspaceWrite: item.workspaceWrite === true,
    owner: item.owner ?? owner,
    ownerActivityKey: item.ownerActivityKey ?? ownerActivityKey,
    _activityKey: item._activityKey ?? activityKey,
  };
  for (const key of ['recommendedConcurrency', 'priority', 'retryPolicy']) {
    if (task[key] === undefined) delete task[key];
  }
  return task;
}

function updatePlanStep(plan, payload) {
  let anomaly = null;
  if (!plan) return anomaly;
  const requestedTaskId = payload.taskId ?? payload.id ?? payload.targetTaskId;
  const step = requestedTaskId != null
    ? plan.find((item) => String(item.id ?? item.step) === String(requestedTaskId))
    : plan.find((item) => item.step === Number(payload.step));
  if (!step) return anomaly;
  /*
   Un statut inconnu ne vaut pas « réussi ».

   La cascade se terminait par `else step.status = 'done'` : tout statut non
   énuméré — `skipped`, par exemple — était projeté en succès. Le runner
   marquait bien une tâche ignorée, la projection la déclarait faite, et le
   résumé de run comptait une réussite qui n'a jamais eu lieu. Le défaut le
   plus dangereux est celui qui transforme une inconnue en bonne nouvelle.

   Trois cas, et un seul mène à `done` :

   - un statut reconnu par le vocabulaire commun est repris tel quel, alias
     compris (`succeeded` → `done`, `error` → `failed`) ;
   - l'ABSENCE de statut garde le contrat historique — un événement de fin
     sans précision signifie « terminé » ;
   - un statut présent mais incompréhensible laisse l'étape dans l'état où
     elle était, et signale une anomalie de projection. On ne sait pas ce qui
     s'est passé : le dire est plus utile que d'inventer une réponse.
  */
  const canonical = normalizeTaskStatus(payload.status);
  if (canonical) {
    step.status = canonical;
  } else if (isUnknownStatus(payload.status)) {
    anomaly = `projection: unknown status "${String(payload.status)}" for plan step ${String(requestedTaskId ?? payload.step ?? '?')} — kept "${String(step.status ?? 'pending')}"`;
  } else {
    step.status = 'done';
  }
  // Le motif d'un abandon est la seule chose qui le rende actionnable :
  // « ignorée » sans « parce que » n'apprend rien à qui relance.
  if (step.status === 'skipped' && payload.reason && !step.error) {
    step.error = { code: 'dependency_failed', message: String(payload.reason) };
  }
  if (payload.activityKey) step.activityKey = payload.activityKey;
  if (Array.isArray(payload.outputRefs)) step.outputRefs = payload.outputRefs.map(cloneRef);
  if (payload.result) step.result = cloneJson(payload.result);
  if (payload.retryState) step.retryState = cloneJson(payload.retryState);
  if (payload.retryAssignment) step.retryAssignment = cloneJson(payload.retryAssignment);
  return anomaly;
}

function formatPlanErrors(errors) {
  return Array.isArray(errors) && errors.length > 0
    ? errors.map((error) => error.code ?? error.message ?? String(error)).join(', ')
    : 'unknown';
}

const LOG_TIME_PREFIX = /^\d{2}:\d{2}:\d{2}\s+/;
const LOG_REPEAT_SUFFIX = / \(×\d+\)$/;

/*
 The single writer into `state.logs` — every push goes through here.

 Two jobs the ad-hoc `push(...); logs = logs.slice(-200)` pairs did unevenly:
 the 200-entry cap is now applied on every path (the `runtime_log` case never
 capped and grew without bound during a long run), and an entry identical to
 the one before it — once the HH:MM:SS prefix is dropped — is collapsed into a
 `(×N)` counter instead of being printed again. `agent_status` polling and
 repeated progress ticks otherwise bury every readable event under dozens of
 identical rows.
*/
function appendLog(state, line) {
  const text = String(line ?? '').trim();
  if (!text) return;
  const bare = (value) => String(value).replace(LOG_TIME_PREFIX, '').replace(LOG_REPEAT_SUFFIX, '');
  const last = state.logs.at(-1);
  if (last != null && bare(last) === bare(text)) {
    const count = Number(String(last).match(/ \(×(\d+)\)$/)?.[1] ?? '1') + 1;
    state.logs[state.logs.length - 1] = `${String(last).replace(LOG_REPEAT_SUFFIX, '')} (×${count})`;
    return;
  }
  state.logs.push(text);
  if (state.logs.length > 200) state.logs = state.logs.slice(-200);
}

function logTime(ts) {
  const date = ts ? new Date(ts) : new Date();
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 19);
}

function planTaskById(state, taskId) {
  const id = String(taskId ?? '');
  if (!id) return null;
  return (state.plan ?? []).find((step) => String(step.id ?? step.step) === id) ?? null;
}

/*
 The persisted taskId is `<runId-uuid>:<slug>-<hash8>` — neither the UUID nor
 the trailing hash means anything to a reader. Prefer the plan step's business
 label ("Polish deliverable: proposition/presentation"), then its description,
 and only fall back to a de-slugified task name when the plan carries neither.
*/
function taskLabelFor(state, taskId) {
  const step = planTaskById(state, taskId);
  const label = step?.label ?? step?.description ?? null;
  if (label && !/^Step \d+$/.test(label)) return label;
  return shortTaskLabel(taskId) || String(taskId ?? '') || 'task';
}

// One readable line per real task transition. `task.started` and
// `task.result_returned` are deliberately silent in the reducer — each is an
// internal step between two lines this function already prints (`assigned`
// then `completed`/`failed`), and printing them doubled every task in the
// Runtime panel.
function taskLogLine(state, event, kind) {
  const payload = event.payload ?? {};
  const taskId = event.taskId ?? payload.taskId ?? '';
  const label = taskLabelFor(state, taskId);
  const time = logTime(event.ts);
  const step = planTaskById(state, taskId);
  const capability = payload.assignment?.capability ?? step?.requiredCapability ?? null;
  const agent = payload.assignment?.agentInstanceId
    ?? payload.agentInstanceId
    ?? payload.result?.assignment?.agentInstanceId
    ?? payload.assignment?.agentId
    ?? null;

  if (kind === 'assigned') {
    const context = [capability, agent && `→ ${agent}`].filter(Boolean).join('  ');
    return `${time} ▸ ${label} — started${context ? `  (${context})` : ''}`.trim();
  }
  if (kind === 'retry') {
    const attempt = payload.attempts ?? payload.attempt ?? null;
    const max = payload.maxAttempts ?? null;
    const reason = payload.reason
      ?? payload.error?.code
      ?? payload.error?.message
      ?? 'retryable error';
    const nth = attempt != null ? ` ${attempt}${max ? `/${max}` : ''}` : '';
    return `${time} ↻ ${label} — retry${nth} (${reason})`.trim();
  }

  const result = payload.result ?? {};
  if (kind === 'failed') {
    const error = result.error?.code
      ?? result.error?.message
      ?? payload.error?.code
      ?? payload.error?.message
      ?? (result.status && result.status !== 'succeeded' ? result.status : null);
    return `${time} ✗ ${label} — failed${error ? `: ${error}` : ''}`.trim();
  }
  // completed
  const outputs = result.outputRefs ?? result.result?.outputRefs ?? [];
  const count = Array.isArray(outputs) ? outputs.length : 0;
  return `${time} ✓ ${label} — done${count ? ` (${count} output${count > 1 ? 's' : ''})` : ''}`.trim();
}

function cloneRef(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : String(value);
}

function sortedActivities(activities) {
  return Object.values(activities ?? {})
    .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')));
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
