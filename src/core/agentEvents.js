import { normalizeActivity } from './activity.js';
import { attachActivityToExistingPlan, syncActivitiesToPlan } from './plan.js';
import { applyPlanPatch, normalizePlanPatch, normalizePlanRevision, rebasePlanPatch } from './planPatch.js';
import { formatRuntimeLogPayload } from './runtimeLog.js';
import { projectWorkflow } from './workflow.js';
import { validateContractInDev } from '../contracts/schemas.js';

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

function withSessionRunIdentity(event, session) {
  const identity = session?._currentRunIdentity;
  if (!identity) return event;
  return {
    ...event,
    runId: event.runId ?? identity.runId ?? null,
    turnId: event.turnId ?? identity.turnId ?? null,
    taskId: event.taskId ?? identity.taskId ?? null,
    workspace: event.workspace ?? identity.workspace ?? null,
  };
}

export function reduceAgentEvents(events = []) {
  const state = createProjectionState();

  for (const event of events) {
    applyEvent(state, event);
  }

  return publicProjection(state);
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
      state.status = 'running';
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
      state.logs.push(`Plan received for run ${String(event.runId ?? event.payload?.runId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'plan.validated':
      state.logs.push(`Plan validated for run ${String(event.runId ?? event.payload?.runId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'plan.rejected':
      state.logs.push(`Plan rejected: ${formatPlanErrors(event.payload?.errors)}`);
      state.logs = state.logs.slice(-200);
      return;
    case 'task_group.created':
      return;
    case 'task.created':
      appendCreatedTask(state, event.payload?.task);
      return;
    case 'task.assigned':
      state.logs.push(`Task assigned: ${String(event.taskId ?? event.payload?.taskId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'task.started':
      state.logs.push(`Task started: ${String(event.taskId ?? event.payload?.taskId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'task.retry_scheduled':
      state.logs.push(`Task retry scheduled: ${String(event.taskId ?? event.payload?.taskId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'task.result_returned':
      state.logs.push(`Task result returned: ${String(event.taskId ?? event.payload?.taskId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'task.completed':
      state.logs.push(`Task completed: ${String(event.taskId ?? event.payload?.taskId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'task.failed':
      state.logs.push(`Task failed: ${String(event.taskId ?? event.payload?.taskId ?? '')}`.trim());
      state.logs = state.logs.slice(-200);
      return;
    case 'plan.revision_changed':
      if (Array.isArray(event.payload?.tasks)) {
        state.plan = normalizePlan(event.payload.tasks, { owner: 'orchestrator', planRevision: state.planRevision });
      }
      state.planRevision = normalizePlanRevision(event.payload?.planRevision ?? state.planRevision + 1);
      return;
    case 'plan_step_updated':
      updatePlanStep(state.plan, event.payload ?? {});
      return;
    case 'control_message_received':
      state.logs.push(`Control message: ${String(event.payload?.input ?? '')}`);
      state.logs = state.logs.slice(-200);
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
      state.logs.push(String(event.payload?.message ?? 'Agent run cancelled.'));
      finishControlByRun(state.controlQueue, event.runId ?? event.payload?.runId ?? null, 'cancelled', event.ts);
      return;
    case 'run_error':
      state.status = 'error';
      state.logs.push(String(event.payload?.message ?? 'Agent run failed.'));
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
      state.logs.push(formatRuntimeLogPayload(event.payload ?? {}, event.ts));
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

function appendAssistantDelta(state, delta) {
  if (!delta) return;
  const last = state.conversation.at(-1);
  if (last?.role === 'assistant' && last.streaming) {
    last.content += delta;
  } else {
    state.conversation.push({ role: 'assistant', content: delta, streaming: true });
  }
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
  if (!plan) return;
  const requestedTaskId = payload.taskId ?? payload.id ?? payload.targetTaskId;
  const step = requestedTaskId != null
    ? plan.find((item) => String(item.id ?? item.step) === String(requestedTaskId))
    : plan.find((item) => item.step === Number(payload.step));
  if (!step) return;
  if (payload.status === 'failed') step.status = 'failed';
  else if (payload.status === 'running') step.status = 'running';
  else if (payload.status === 'pending') step.status = 'pending';
  else if (payload.status === 'pending_approval') step.status = 'pending_approval';
  else if (payload.status === 'waiting_approval') step.status = 'waiting_approval';
  else if (payload.status === 'cancelled') step.status = 'cancelled';
  else step.status = 'done';
  if (payload.activityKey) step.activityKey = payload.activityKey;
  if (Array.isArray(payload.outputRefs)) step.outputRefs = payload.outputRefs.map(cloneRef);
  if (payload.result) step.result = cloneJson(payload.result);
  if (payload.retryState) step.retryState = cloneJson(payload.retryState);
  if (payload.retryAssignment) step.retryAssignment = cloneJson(payload.retryAssignment);
}

function formatPlanErrors(errors) {
  return Array.isArray(errors) && errors.length > 0
    ? errors.map((error) => error.code ?? error.message ?? String(error)).join(', ')
    : 'unknown';
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
