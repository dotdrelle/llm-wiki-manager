import { locksForTask } from './lockManager.js';
import { approvalCovered } from './approvalPolicy.js';

const DONE_STATUSES = new Set(['done', 'completed', 'complete', 'success', 'succeeded']);
const TERMINAL_STATUSES = new Set([...DONE_STATUSES, 'failed', 'cancelled', 'canceled', 'skipped']);
// A task in one of these statuses hasn't run yet but could become ready —
// shared with runner.js's scheduler-stall check so the two can't drift apart.
export const PENDING_STATUSES = new Set(['pending', 'pending_approval', 'waiting_approval']);

export function readyTasks(dag, {
  registry = null,
  lockManager = null,
  budgetManager = null,
  approvals = [],
  activeTaskIds = [],
} = {}) {
  const tasks = normalizeTasks(dag);
  const done = new Set(tasks.filter((task) => DONE_STATUSES.has(statusOf(task))).map(taskId));
  const active = new Set([...activeTaskIds].map(String));
  return tasks
    .filter((task) => {
      const status = statusOf(task);
      return status === 'pending'
        || (PENDING_STATUSES.has(status)
          && approvalCovered(task, approvals, {
            runId: task?.runId ?? dag?.runId ?? null,
            workspaceId: dag?.workspace ?? null,
            planRevision: dag?.planRevision ?? null,
          }));
    })
    .filter((task) => !active.has(taskId(task)))
    .filter((task) => dependenciesDone(task, done))
    .filter((task) => groupBarrierSatisfied(task, tasks))
    .filter((task) => approvalCovered(task, approvals, { runId: task?.runId ?? dag?.runId ?? null, workspaceId: dag?.workspace ?? null, planRevision: dag?.planRevision ?? null }))
    .filter((task) => agentSane(task, registry))
    .filter((task) => locksFree(task, lockManager))
    .filter((task) => budgetOk(task, budgetManager))
    .sort(compareTaskPriority);
}

export function tasksAwaitingApproval(dag, { approvals = [] } = {}) {
  const tasks = normalizeTasks(dag);
  const done = new Set(tasks.filter((task) => DONE_STATUSES.has(statusOf(task))).map(taskId));
  return tasks
    .filter((task) => PENDING_STATUSES.has(statusOf(task)))
    .filter((task) => task?.requiresApproval === true)
    .filter((task) => !approvalCovered(task, approvals, {
      runId: task?.runId ?? dag?.runId ?? null,
      workspaceId: dag?.workspace ?? null,
      planRevision: dag?.planRevision ?? null,
    }))
    .filter((task) => dependenciesDone(task, done))
    .filter((task) => groupBarrierSatisfied(task, tasks));
}

function normalizeTasks(dag) {
  if (Array.isArray(dag)) return dag;
  if (Array.isArray(dag?.tasks)) return dag.tasks;
  if (Array.isArray(dag?.plan)) return dag.plan;
  return [];
}

function dependenciesDone(task, done) {
  return dependsOn(task).every((dep) => done.has(String(dep)));
}

function groupBarrierSatisfied(task, tasks) {
  const groupId = task?.dependsOnGroup;
  if (groupId == null || groupId === '') return true;
  const groupTasks = tasks.filter((candidate) => taskGroupId(candidate) === String(groupId));
  if (groupTasks.length === 0) return false;
  return groupTasks.every((candidate) => DONE_STATUSES.has(statusOf(candidate)));
}

function agentSane(task, registry) {
  if (!registry || typeof registry.providersFor !== 'function') return true;
  const capability = task?.requiredCapability;
  if (!capability) return false;
  const providers = registry.providersFor(capability) ?? [];
  return providers.some((provider) => providerSupportsTask(provider, task, registry));
}

function providerSupportsTask(provider, task, registry) {
  const contractVersion = provider?.description?.contractVersion ?? provider?.contractVersion;
  if (typeof registry?.isCompatible === 'function' && !registry.isCompatible(contractVersion)) return false;
  const health = String(provider?.health ?? provider?.description?.health?.status ?? '');
  if (!['available', 'degraded'].includes(health)) return false;
  if (provider?.available === false || provider?.availability === 'unavailable') return false;
  const operations = provider?.capability?.supportedOperations ?? [];
  return !task?.operation || operations.length === 0 || operations.includes(task.operation);
}

function locksFree(task, lockManager) {
  if (!lockManager) return true;
  if (typeof lockManager.canAcquire === 'function') return lockManager.canAcquire(task);
  const locked = new Set(lockManager.lockedLocks ?? lockManager.locks ?? []);
  return locksForTask(task).every((lock) => !locked.has(lock));
}

function budgetOk(task, budgetManager) {
  if (!budgetManager || typeof budgetManager.canStartTask !== 'function') return true;
  return budgetManager.canStartTask(task);
}

function compareTaskPriority(a, b) {
  return priority(a) - priority(b)
    || stepNumber(a) - stepNumber(b)
    || taskId(a).localeCompare(taskId(b));
}

function priority(task) {
  const value = Number(task?.priority);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function stepNumber(task) {
  const value = Number(task?.step);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function statusOf(task) {
  return String(task?.status ?? 'pending').toLowerCase();
}

function dependsOn(task) {
  return Array.isArray(task?.dependsOn) ? task.dependsOn : [];
}

function taskGroupId(task) {
  return task?.groupId ?? task?.group ?? task?.taskGroupId ?? null;
}

function taskId(task) {
  return String(task?.id ?? task?.step);
}

export function isTerminalTask(task) {
  return TERMINAL_STATUSES.has(statusOf(task));
}
