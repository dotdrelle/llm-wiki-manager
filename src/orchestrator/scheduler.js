import { readyTasks } from './dependencyResolver.js';

export const DEFAULT_SCHEDULER_CONCURRENCY = 3;

export function resolveSchedulerConcurrency(value = process.env.WIKI_MANAGER_SCHEDULER_CONCURRENCY) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : DEFAULT_SCHEDULER_CONCURRENCY;
}

export function effectiveConcurrency(group = null, agent = null, donna = null, provider = null) {
  const limits = [
    ...concurrencyValues(donna),
    ...concurrencyValues(group),
    ...concurrencyValues(provider),
    ...concurrencyValues(agent),
  ].filter((value) => value != null && value > 0);
  return Math.max(1, Math.min(...(limits.length ? limits : [DEFAULT_SCHEDULER_CONCURRENCY])));
}

export async function drainActive(active, attemptManager = null) {
  if (active.size === 0) return;
  const entries = [...active.values()];
  await Promise.all(entries.map((entry) => entry.promise));
  for (const entry of entries) entry.cleanup?.();
  active.clear();
  attemptManager?.clear?.();
}

export function startReadyTasks({
  plan,
  active,
  attemptManager,
  startTask,
  limit,
  session = null,
  registry = null,
  lockManager = null,
  budgetManager = null,
  approvals = [],
  onDuplicateTask = null,
  onTaskStarting = null,
} = {}) {
  let started = 0;
  const seenTaskIds = new Set(active.keys());
  const ready = readyTasks(plan, {
    registry,
    lockManager,
    budgetManager,
    approvals,
    activeTaskIds: active.keys(),
  });
  for (const task of ready) {
    if (active.size >= limit) break;
    const taskId = planTaskId(task);
    if (active.has(taskId)) continue;
    if (seenTaskIds.has(taskId)) {
      onDuplicateTask?.(taskId, task);
      continue;
    }
    seenTaskIds.add(taskId);
    const attempt = attemptManager.reserve(task);
    if (!attempt) continue;
    budgetManager?.recordTaskStart?.(task);
    onTaskStarting?.(task, attempt);
    const entry = startTask(task, attempt);
    active.set(taskId, { taskId, ...entry });
    started += 1;
  }
  return started;
}

function concurrencyValues(source) {
  if (source == null) return [];
  if (typeof source === 'number') return [positiveInteger(source)].filter(Boolean);
  const candidates = [
    source,
    source.limits,
    source.description?.limits,
    source.capability?.limits,
  ].filter(Boolean);
  return candidates.flatMap((limits) => [
    limits.effectiveConcurrency,
    limits.maxConcurrency,
    limits.recommendedConcurrency,
    limits.concurrency,
    limits.schedulerConcurrency,
  ]).map(positiveInteger).filter(Boolean);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function planTaskId(task) {
  return String(task?.id ?? task?.step);
}
