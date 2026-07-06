import { validateContractInDev } from '../contracts/schemas.js';

const PATCH_OPS = new Set([
  'add_task',
  'add_dependency',
  'remove_dependency',
  'cancel_task',
  'replace_executor',
  'request_approval',
]);

export function normalizePlanRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
}

export function normalizePlanPatch(raw = {}, { targetRunId = null, basePlanRevision = 0 } = {}) {
  const operations = Array.isArray(raw.operations) ? raw.operations : [];
  return validateContractInDev('planPatch', {
    id: raw.id ?? null,
    targetRunId: raw.targetRunId ?? targetRunId ?? null,
    basePlanRevision: normalizePlanRevision(raw.basePlanRevision ?? basePlanRevision),
    operations: operations.map(normalizePatchOperation).filter(Boolean),
    reason: raw.reason ?? null,
  });
}

export function applyPlanPatch(plan, patch, { currentRevision = 0 } = {}) {
  const basePlanRevision = normalizePlanRevision(patch?.basePlanRevision);
  const revision = normalizePlanRevision(currentRevision);
  if (basePlanRevision !== revision) {
    return {
      ok: false,
      reason: 'revision_mismatch',
      basePlanRevision,
      currentRevision: revision,
      plan,
    };
  }
  const nextPlan = (plan ?? []).map((step, index) => normalizeTask(step, index));
  // Build the id index one task at a time (rather than `new Map(nextPlan.map(...))`)
  // so a collision between a legacy step's positional-number fallback id and
  // another step's explicit string id (e.g. a step with id:"3" alongside a
  // legacy, id-less step at position 3) is rejected instead of silently
  // dropping one of the two tasks from lookup (Map construction keeps the
  // last entry on a duplicate key).
  const tasksById = new Map();
  for (const task of nextPlan) {
    const id = taskId(task);
    if (tasksById.has(id)) {
      return { ok: false, reason: 'duplicate_task_id', plan, conflictingId: id };
    }
    tasksById.set(id, task);
  }
  // Two-phase: apply every add_task first regardless of its position in the
  // operations array, then everything else — so e.g. an add_dependency op
  // can reference a task added later in the same patch without the whole
  // patch failing purely on operation order. Relative order is preserved
  // within each phase.
  const operations = patch?.operations ?? [];
  const orderedOperations = [
    ...operations.filter((operation) => operation.op === 'add_task'),
    ...operations.filter((operation) => operation.op !== 'add_task'),
  ];
  for (const operation of orderedOperations) {
    const result = applyOperation(nextPlan, tasksById, operation);
    if (!result.ok) return { ...result, plan };
  }
  if (hasDependencyCycle(nextPlan)) {
    return { ok: false, reason: 'dependency_cycle', plan };
  }
  resequence(nextPlan);
  return {
    ok: true,
    plan: nextPlan,
    planRevision: revision + 1,
  };
}

export function rebasePlanPatch(patch, { currentRevision = 0 } = {}) {
  return {
    ...patch,
    basePlanRevision: normalizePlanRevision(currentRevision),
    rebasedFromRevision: normalizePlanRevision(patch?.basePlanRevision),
  };
}

export function readyPlanTasks(plan) {
  const { plan: tasks } = sanitizePlanForExecution(plan);
  const done = new Set(tasks.filter((task) => task.status === 'done').map(taskId));
  return tasks
    .filter((task) => task.status === 'pending')
    .filter((task) => task.dependsOn.every((dep) => done.has(String(dep))))
    .sort((a, b) => a.step - b.step);
}

export function nextReadyPlanTask(plan) {
  return readyPlanTasks(plan)[0] ?? null;
}

export function formatReadyTaskPrompt(task) {
  if (!task) return 'No ready task is available.';
  const lines = [
    `Next ready task: ${task.step}. ${task.description}`,
    task.id ? `Task id: ${task.id}` : null,
    task.executor ? `Preferred executor: ${task.executor}` : null,
    task.executorQuery ? `Executor query: ${JSON.stringify(task.executorQuery)}` : null,
    task.dependsOn.length > 0 ? `Dependencies satisfied: ${task.dependsOn.join(', ')}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export function normalizeTask(raw, index = 0) {
  const item = raw && typeof raw === 'object' ? raw : { description: String(raw ?? '') };
  return {
    ...item,
    step: Number(item.step ?? index + 1),
    id: item.id != null ? String(item.id) : null,
    description: String(item.description ?? item.label ?? item.name ?? `Step ${index + 1}`),
    status: String(item.status ?? 'pending'),
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
    executor: item.executor ?? null,
    executorQuery: item.executorQuery ?? null,
    outputRefs: Array.isArray(item.outputRefs) ? item.outputRefs.map(String) : [],
  };
}

export function sanitizePlanForExecution(plan) {
  const tasks = (plan ?? []).map((step, index) => normalizeTask(step, index));
  const warnings = [];
  const ids = new Set(tasks.map(taskId));
  for (const task of tasks) {
    const before = task.dependsOn;
    task.dependsOn = before.filter((dep) => ids.has(String(dep)));
    if (task.dependsOn.length !== before.length) {
      warnings.push(`unknown dependency removed from task ${taskId(task)}`);
    }
  }
  const pending = tasks.filter((task) => task.status === 'pending');
  const done = new Set(tasks.filter((task) => task.status === 'done').map(taskId));
  const terminalBlocked = new Set(
    tasks
      .filter((task) => ['failed', 'cancelled', 'canceled'].includes(String(task.status).toLowerCase()))
      .map(taskId),
  );
  const hasReady = pending.some((task) => task.dependsOn.every((dep) => done.has(String(dep))));
  if (hasDependencyCycle(tasks)) {
    warnings.push('dependency cycle broken by sequential fallback');
    return { plan: sequentialize(tasks), warnings };
  }
  if (pending.length > 0 && !hasReady && !pending.some((task) => task.dependsOn.some((dep) => terminalBlocked.has(String(dep))))) {
    warnings.push('no ready task after dependency cleanup; using sequential fallback');
    return { plan: sequentialize(tasks), warnings };
  }
  return { plan: tasks, warnings };
}

function normalizePatchOperation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const op = String(raw.op ?? '');
  if (!PATCH_OPS.has(op)) return null;
  return { ...raw, op };
}

function normalizeAddedTask(raw, index) {
  const task = normalizeTask(raw, index);
  return {
    ...task,
    status: task.status === 'done' || task.status === 'running' ? task.status : 'pending',
    owner: task.owner ?? 'orchestrator',
    ownerActivityKey: task.ownerActivityKey ?? null,
    _activityKey: task._activityKey ?? null,
  };
}

function taskId(task) {
  return String(task.id ?? task.step);
}

function targetTask(tasksById, operation) {
  const id = operation.taskId ?? operation.id ?? operation.targetTaskId;
  return id == null ? null : tasksById.get(String(id)) ?? null;
}

function applyOperation(plan, tasksById, operation) {
  if (operation.op === 'add_task') {
    const task = normalizeAddedTask(operation.task, plan.length);
    if (!task.id) return { ok: false, reason: 'missing_task_id', operation };
    if (tasksById.has(task.id)) return { ok: false, reason: 'duplicate_task_id', operation };
    plan.push(task);
    tasksById.set(task.id, task);
    return { ok: true };
  }
  const task = targetTask(tasksById, operation);
  if (!task) return { ok: false, reason: 'task_not_found', operation };
  if (operation.op === 'add_dependency') {
    const dep = String(operation.dependsOn ?? operation.dependency ?? operation.dependencyId ?? '');
    if (!dep) return { ok: false, reason: 'missing_dependency', operation };
    if (!tasksById.has(dep)) return { ok: false, reason: 'dependency_not_found', operation };
    if (!task.dependsOn.includes(dep)) task.dependsOn.push(dep);
    return { ok: true };
  }
  if (operation.op === 'remove_dependency') {
    const dep = String(operation.dependsOn ?? operation.dependency ?? operation.dependencyId ?? '');
    task.dependsOn = task.dependsOn.filter((item) => item !== dep);
    return { ok: true };
  }
  if (operation.op === 'cancel_task') {
    task.status = 'cancelled';
    return { ok: true };
  }
  if (operation.op === 'replace_executor') {
    task.executor = operation.executor ?? null;
    task.executorQuery = operation.executorQuery ?? task.executorQuery ?? null;
    return { ok: true };
  }
  if (operation.op === 'request_approval') {
    task.status = 'pending_approval';
    task.approvalReason = operation.reason ?? 'approval_required';
    return { ok: true };
  }
  return { ok: false, reason: 'unsupported_operation', operation };
}

function resequence(plan) {
  plan.forEach((task, index) => {
    task.step = index + 1;
  });
}

function sequentialize(plan) {
  const next = plan.map((task) => ({ ...task, dependsOn: [] }));
  for (let index = 1; index < next.length; index += 1) {
    next[index].dependsOn = [taskId(next[index - 1])];
  }
  return next;
}

function hasDependencyCycle(plan) {
  const tasks = new Map(plan.map((task) => [taskId(task), task]));
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    const task = tasks.get(id);
    if (!task) return false;
    visiting.add(id);
    for (const dep of task.dependsOn) {
      if (visit(String(dep))) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const id of tasks.keys()) {
    if (visit(id)) return true;
  }
  return false;
}
