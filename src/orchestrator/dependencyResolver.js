import { locksForTask } from './lockManager.js';
import { approvalCovered } from './approvalPolicy.js';
import { isPending, isSuccessful, isTerminal, isUnsuccessfulTerminal } from './taskStatuses.js';
// A task in one of these statuses has not run yet but may become able to.
// Re-exported from the shared vocabulary: the scheduler and the runner's stall
// check must test the same thing, and a local set here was precisely the way
// to make them diverge.
export { isPending } from './taskStatuses.js';

export function readyTasks(dag, {
  registry = null,
  lockManager = null,
  budgetManager = null,
  approvals = [],
  activeTaskIds = [],
} = {}) {
  const tasks = normalizeTasks(dag);
  const done = new Set(tasks.filter((task) => isSuccessful(statusOf(task))).map(taskId));
  const active = new Set([...activeTaskIds].map(String));
  return tasks
    .filter((task) => {
      const status = statusOf(task);
      return status === 'pending'
        || (isPending(status)
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
  const done = new Set(tasks.filter((task) => isSuccessful(statusOf(task))).map(taskId));
  return tasks
    .filter((task) => isPending(statusOf(task)))
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

/*
 A group barrier waits for the group to be FINISHED, not perfect.

 It required every member to be `done`. A single failure therefore closed it
 forever: on an ingestion of ten files where nine succeed, the rest of the
 plan was never unblocked and the run stayed `running` forever. One document
 incident became a total breakdown — the cost was unrelated to the damage.

 The barrier therefore opens when the whole group is TERMINAL. What the "all
 done" guarantee really meant is preserved elsewhere, and more finely: a task
 that explicitly depends on a failed task stays blocked by `dependenciesDone`,
 and the scheduler marks it `skipped` (see blockedByFailedDependency). We thus
 distinguish "the rest cannot happen" from "the rest can happen on what
 succeeded".
*/
function groupBarrierSatisfied(task, tasks) {
  const groupId = task?.dependsOnGroup;
  if (groupId == null || groupId === '') return true;
  const groupTasks = tasks.filter((candidate) => taskGroupId(candidate) === String(groupId));
  if (groupTasks.length === 0) return false;
  return groupTasks.every((candidate) => isTerminal(statusOf(candidate)));
}

/**
 * Pending tasks that will NEVER become executable, because one of their
 * direct dependencies is terminal without having succeeded.
 *
 * Without this list, the scheduler could only note "no ready task left" and
 * declare the plan blocked — which triggered a replan, hence a run that does
 * not finish. Naming them allows marking them `skipped` with their reason,
 * finalising the run on a partial result, and telling the user what was not
 * done and why.
 */
export function blockedByFailedDependency(dag) {
  const tasks = normalizeTasks(dag);
  const statusById = new Map(tasks.map((task) => [taskId(task), statusOf(task)]));
  return tasks
    .filter((task) => isPending(statusOf(task)))
    .map((task) => {
      const culprits = dependsOn(task)
        .map(String)
        .filter((dependency) => isUnsuccessfulTerminal(statusById.get(dependency) ?? ''));
      return culprits.length > 0 ? { task, dependencies: culprits } : null;
    })
    .filter(Boolean);
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

