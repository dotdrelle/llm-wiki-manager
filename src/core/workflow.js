const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'canceled', 'error', 'complete', 'completed', 'success']);
const RUNNING_STATUSES = new Set(['running', 'starting', 'queued', 'waiting', 'pending_approval']);

// Canonical workflow projection for 0.9.6.
//
// Decision: projectWorkflow consumes the existing event-sourced agentProjection
// instead of replacing it in this release. agentProjection remains the
// compatibility reducer/hydration format; workflow is the canonical read model
// for Serve and ShellTUI. Future releases can move the reducer internals behind
// this module without changing UI contracts.
export function projectWorkflow(state = {}, events = []) {
  const run = currentRun(state, events);
  const plan = Array.isArray(state.plan) ? state.plan : [];
  const activities = Array.isArray(state.activities) ? state.activities : [];
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  const replans = Array.isArray(state.replans) ? state.replans : [];
  const evaluation = state.evaluation ?? null;
  const nodes = [];
  const relations = [];
  const warnings = [];

  if (run) nodes.push(run);
  const planNodes = plan.map((step, index) => taskNode(step, index));
  const activityNodes = activities.map(activityNode);
  const queueNodes = queue.map(queueNode);
  const approvalNodes = approvals.map(approvalNode);
  nodes.push(...planNodes, ...activityNodes, ...queueNodes, ...approvalNodes);

  for (const node of [...planNodes, ...activityNodes, ...queueNodes, ...approvalNodes]) {
    if (run) relations.push({ type: 'contains', from: run.id, to: node.id });
  }

  const taskByStepId = new Map(planNodes.map((node) => [node.stepId, node]));
  const taskByActivity = new Map();
  for (const node of planNodes) {
    for (const activityKey of [node.activityKey, node.ownerActivityKey].filter(Boolean)) {
      if (!taskByActivity.has(activityKey)) taskByActivity.set(activityKey, []);
      taskByActivity.get(activityKey).push(node);
    }
    for (const dep of node.dependsOn) {
      const depNode = taskByStepId.get(String(dep)) ?? planNodes.find((candidate) => candidate.step === Number(dep));
      if (depNode) relations.push({ type: 'depends_on', from: node.id, to: depNode.id });
    }
    if (node.executor) {
      const executorId = `executor:${node.executor}`;
      if (!nodes.some((candidate) => candidate.id === executorId)) {
        nodes.push({ id: executorId, type: 'executor', label: node.executor, status: 'available' });
      }
      relations.push({ type: 'executed_by', from: node.id, to: executorId });
    }
    for (const ref of node.outputRefs) {
      const outputId = `output:${String(ref)}`;
      if (!nodes.some((candidate) => candidate.id === outputId)) {
        nodes.push({ id: outputId, type: 'output', label: String(ref), status: 'done' });
      }
      relations.push({ type: 'produces', from: node.id, to: outputId });
    }
  }

  for (const activity of activityNodes) {
    const targets = taskByActivity.get(activity.key) ?? [];
    if (targets.length > 0) {
      for (const task of targets) relations.push({ type: 'executed_by', from: task.id, to: activity.id });
    } else if (planNodes.length > 0 && isActiveStatus(activity.status)) {
      const currentTask = planNodes.find((node) => node.status === 'running') ?? planNodes.find((node) => node.status === 'pending');
      if (currentTask) relations.push({ type: 'executed_by', from: currentTask.id, to: activity.id });
    }
  }

  for (const approval of approvalNodes) {
    const target = approval.itemId ? queueNodes.find((node) => node.itemId === approval.itemId) : run;
    if (target) relations.push({ type: 'approves', from: approval.id, to: target.id });
  }

  for (const [index, replan] of replans.entries()) {
    const replanId = `replan:${replan.runId ?? index}`;
    nodes.push({ id: replanId, type: 'replan', label: replan.reason || 'Replan', status: 'done', replan });
    if (run) relations.push({ type: 'replaces', from: replanId, to: run.id });
  }

  if (planNodes.length > 0 && !planNodes.some((node) => node.structured)) {
    warnings.push('legacy_sequential_plan');
  }
  if (events.some((event) => event.type === 'plan_set' && event.origin === 'llm')) {
    warnings.push('deprecated_text_plan_extraction');
  }

  const current = findCurrentNode(nodes);
  const next = findNextTask(planNodes);
  const progress = computeProgress({ planNodes, activityNodes, state });
  const waitingReasons = computeWaitingReasons({ nodes, queueNodes, approvalNodes });
  const summary = buildSummary({ state, run, current, next, progress, evaluation });

  return {
    summary,
    nodes,
    relations,
    current,
    next,
    progress,
    waitingReasons,
    warnings,
  };
}

function currentRun(state, events) {
  const runId = state.runId ?? state.runs?.find((run) => isActiveStatus(run.status))?.id ?? events.findLast?.((event) => event.runId)?.runId ?? null;
  if (!runId && !state.status) return null;
  return {
    id: runId ? `run:${runId}` : 'run:current',
    type: 'run',
    runId,
    label: state.summary || state.input || 'Runtime run',
    status: normalizeStatus(state.status ?? 'idle'),
    workspace: state.workspace ?? null,
    startedAt: state.startedAt ?? state.runs?.find((run) => run.id === runId)?.createdAt ?? null,
    updatedAt: state.updatedAt ?? state.runs?.find((run) => run.id === runId)?.updatedAt ?? null,
  };
}

function taskNode(step, index) {
  const stepId = String(step.id ?? step.step ?? index + 1);
  const structured = Boolean(step.id || step.dependsOn || step.executor || step.outputRefs);
  return {
    id: `task:${stepId}`,
    type: 'task',
    step: Number(step.step ?? index + 1),
    stepId,
    label: String(step.description ?? step.label ?? step.name ?? `Step ${index + 1}`),
    description: String(step.description ?? step.label ?? step.name ?? `Step ${index + 1}`),
    status: normalizeStatus(step.status ?? 'pending'),
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
    executor: step.executor ?? null,
    outputRefs: Array.isArray(step.outputRefs) ? step.outputRefs.map(String) : [],
    activityKey: step.activityKey ?? null,
    ownerActivityKey: step.ownerActivityKey ?? null,
    structured,
    raw: { ...step },
  };
}

function activityNode(activity, index) {
  const derivedKey = [activity.source, activity.id ?? activity.jobId ?? activity.label].filter(Boolean).join(':');
  const key = (activity.key ?? derivedKey) || `activity:${index + 1}`;
  return {
    id: `activity:${key}`,
    type: 'activity',
    key,
    label: activity.label ?? activity.tool ?? key,
    status: normalizeStatus(activity.status ?? 'running'),
    source: activity.source ?? null,
    progress: activity.progress ?? null,
    terminal: Boolean(activity.terminal),
    startedAt: activity.startedAt ?? null,
    updatedAt: activity.updatedAt ?? null,
    raw: { ...activity },
  };
}

function queueNode(item) {
  return {
    id: `queue:${item.id ?? item.jobId ?? item.step ?? item.label}`,
    type: 'queue',
    itemId: item.id ?? null,
    label: item.label ?? item.tool ?? item.type ?? item.input ?? 'Queued item',
    status: normalizeStatus(item.status ?? 'queued'),
    workspace: item.workspace ?? null,
    raw: { ...item },
  };
}

function approvalNode(approval) {
  return {
    id: `approval:${approval.id ?? approval.itemId ?? approval.runId}`,
    type: 'approval',
    label: approval.reason ?? approval.tool ?? 'Approval',
    status: normalizeStatus(approval.status ?? 'pending_approval'),
    itemId: approval.itemId ?? null,
    runId: approval.runId ?? null,
    raw: { ...approval },
  };
}

function normalizeStatus(status) {
  const value = String(status ?? 'pending').toLowerCase();
  if (value === 'canceled') return 'cancelled';
  if (value === 'complete' || value === 'completed' || value === 'success') return 'done';
  if (value === 'error') return 'failed';
  if (value === 'pending_approval') return 'pending_approval';
  if (['pending', 'queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'stalled', 'added_during_run'].includes(value)) return value;
  return value || 'pending';
}

function isActiveStatus(status) {
  return RUNNING_STATUSES.has(normalizeStatus(status));
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

function findCurrentNode(nodes) {
  const workflowNodes = nodes.filter((node) => node.type !== 'run');
  return workflowNodes.find((node) => node.status === 'running')
    ?? workflowNodes.find((node) => node.status === 'pending_approval')
    ?? workflowNodes.find((node) => node.status === 'waiting')
    ?? workflowNodes.find((node) => node.status === 'queued')
    ?? nodes.find((node) => node.status === 'running')
    ?? null;
}

function findNextTask(tasks) {
  const doneIds = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.stepId));
  return tasks.find((task) => task.status === 'pending' && task.dependsOn.every((dep) => doneIds.has(String(dep))))
    ?? tasks.find((task) => task.status === 'pending')
    ?? null;
}

function computeProgress({ planNodes, activityNodes, state }) {
  const activityWithPercent = activityNodes.find((activity) => Number.isFinite(Number(activity.progress?.percent)));
  if (activityWithPercent) {
    return {
      mode: 'activity_percent',
      percent: Math.max(0, Math.min(100, Number(activityWithPercent.progress.percent))),
      label: activityWithPercent.progress?.detail ?? activityWithPercent.label,
      updatedAt: activityWithPercent.updatedAt ?? null,
    };
  }
  const activityWithCounts = activityNodes.find((activity) => Number.isFinite(Number(activity.progress?.done)) && Number.isFinite(Number(activity.progress?.total)) && Number(activity.progress.total) > 0);
  if (activityWithCounts) {
    const done = Number(activityWithCounts.progress.done);
    const total = Number(activityWithCounts.progress.total);
    return { mode: 'activity_count', percent: Math.round((done / total) * 100), done, total, label: activityWithCounts.label };
  }
  const phase = activityNodes.find((activity) => activity.progress?.phase || activity.progress?.step)?.progress;
  if (phase) return { mode: 'phase', percent: null, label: phase.phase ?? phase.step ?? phase.detail ?? null };
  if (planNodes.length > 0) {
    const terminal = planNodes.filter((task) => isTerminalStatus(task.status)).length;
    return { mode: 'task_count', percent: Math.round((terminal / planNodes.length) * 100), done: terminal, total: planNodes.length };
  }
  return { mode: 'indeterminate', percent: null, label: state.status ?? null };
}

function computeWaitingReasons({ nodes, queueNodes, approvalNodes }) {
  const reasons = [];
  for (const approval of approvalNodes.filter((node) => node.status === 'pending_approval')) reasons.push(approval.id);
  for (const item of queueNodes.filter((node) => ['queued', 'waiting'].includes(node.status))) reasons.push(item.id);
  const stalled = nodes.filter((node) => node.status === 'stalled');
  for (const item of stalled) reasons.push(`stalled:${item.id}`);
  return reasons;
}

function buildSummary({ state, run, current, next, progress, evaluation }) {
  return {
    status: normalizeStatus(state.status ?? run?.status ?? 'idle'),
    text: state.summary ?? current?.label ?? next?.label ?? null,
    currentId: current?.id ?? null,
    nextId: next?.id ?? null,
    progress,
    evaluation,
  };
}
