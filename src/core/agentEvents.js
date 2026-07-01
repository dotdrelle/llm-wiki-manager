import { normalizeActivity } from './activity.js';
import { attachActivityToExistingPlan, syncActivitiesToPlan } from './plan.js';

const SESSION_PROJECTION_EVENTS = new Set([
  'run_started',
  'plan_set',
  'plan_step_updated',
  'activity_upserted',
  'run_evaluated',
  'run_replanned',
  'run_pending_approval',
  'run_approved',
  'tool_pending_approval',
  'tool_approved',
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
  'plan_step_updated',
  'activity_upserted',
  'run_done',
]);

export function createAgentEvent(type, {
  origin = 'system',
  payload = {},
  runId = null,
  turnId = null,
  workspace = null,
} = {}) {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    type,
    origin,
    runId,
    turnId,
    workspace,
    payload,
  };
}

export function dispatchAgentEvent(session, event) {
  const normalized = withSessionRunIdentity(
    event.id && event.ts ? event : createAgentEvent(event.type, event),
    session,
  );
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
    summary: null,
    status: 'idle',
  };
}

function publicProjection(state) {
  return {
    conversation: state.conversation.map((message) => ({ ...message })),
    chain: state.chain.map((step) => ({ ...step })),
    plan: state.plan ? state.plan.map((step) => ({ ...step })) : null,
    activities: sortedActivities(state.activities).map((activity) => ({ ...activity })),
    logs: [...state.logs],
    evaluation: state.evaluation ? { ...state.evaluation } : null,
    replans: state.replans.map((replan) => ({ ...replan, plan: [...(replan.plan ?? [])] })),
    approvals: state.approvals.map((approval) => ({ ...approval })),
    summary: state.summary,
    status: state.status,
  };
}

export function applyAgentProjectionToSession(session, projection) {
  session.headlessPlan = projection.plan ? projection.plan.map((step) => ({ ...step })) : null;
  session.activities = Object.fromEntries((projection.activities ?? []).map((activity) => [activity.key, { ...activity }]));
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
      state.plan = defaultRunPlan();
      state.chain = [];
      state.activities = {};
      state.logs = [];
      state.evaluation = null;
      state.replans = [];
      state.approvals = [];
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
      return;
    case 'plan_step_updated':
      updatePlanStep(state.plan, event.payload ?? {});
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
    case 'run_done':
      state.status = 'done';
      finishPendingPlanSteps(state.plan);
      return;
    case 'run_cancelled':
      state.status = 'cancelled';
      state.logs.push(String(event.payload?.message ?? 'Agent run cancelled.'));
      return;
    case 'run_error':
      state.status = 'error';
      state.logs.push(String(event.payload?.message ?? 'Agent run failed.'));
      return;
    case 'runtime_log':
      state.logs.push(String(event.payload?.message ?? ''));
      state.logs = state.logs.slice(-200);
      return;
    default:
      return;
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
  const index = state.approvals.findIndex((approval) => approval.id === next.id);
  if (index === -1) {
    state.approvals.push(next);
    return;
  }
  state.approvals[index] = {
    ...state.approvals[index],
    ...next,
  };
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
    owner: 'activity',
    ownerActivityKey: activity.key,
    _activityKey: activity.key,
  }];
}

function normalizePlan(steps, payload = {}) {
  if (!Array.isArray(steps)) return null;
  const owner = payload.owner ?? 'orchestrator';
  const ownerActivityKey = payload.ownerActivityKey ?? payload.activityKey ?? null;
  return steps.map((raw, i) => {
    const item = typeof raw === 'string' ? { description: raw } : (raw ?? {});
    return {
      step: Number(item.step ?? i + 1),
      id: item.id ?? null,
      description: String(item.description ?? item.label ?? item.name ?? `Step ${i + 1}`),
      status: item.status ?? 'pending',
      owner: item.owner ?? owner,
      ownerActivityKey: item.ownerActivityKey ?? ownerActivityKey,
      _activityKey: item._activityKey ?? payload.activityKey ?? null,
    };
  });
}

function defaultRunPlan() {
  return [
    { step: 1, id: 'analyze', description: 'Analyze the request', status: 'running', owner: 'orchestrator', ownerActivityKey: null, _activityKey: null },
    { step: 2, id: 'execute', description: 'Execute the required actions', status: 'pending', owner: 'orchestrator', ownerActivityKey: null, _activityKey: null },
    { step: 3, id: 'verify', description: 'Verify the result', status: 'pending', owner: 'orchestrator', ownerActivityKey: null, _activityKey: null },
  ];
}

function updatePlanStep(plan, payload) {
  if (!plan) return;
  const step = plan.find((item) => item.step === Number(payload.step));
  if (!step) return;
  step.status = payload.status === 'failed' ? 'failed' : payload.status === 'running' ? 'running' : 'done';
  if (payload.activityKey) step.activityKey = payload.activityKey;
}

function sortedActivities(activities) {
  return Object.values(activities ?? {})
    .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')));
}
