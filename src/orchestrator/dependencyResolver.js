import { locksForTask } from './lockManager.js';
import { approvalCovered } from './approvalPolicy.js';
import { isPending, isSuccessful, isTerminal, isUnsuccessfulTerminal } from './taskStatuses.js';
// Une tâche dans un de ces statuts n'a pas encore tourné mais peut le devenir.
// Réexporté depuis le vocabulaire commun : l'ordonnanceur et le contrôle de
// blocage du runner doivent tester la même chose, et un ensemble local ici
// était précisément le moyen de les faire diverger.
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
 Une barrière de groupe attend que le groupe soit FINI, pas qu'il soit parfait.

 Elle exigeait que chaque membre soit `done`. Un seul échec la fermait donc
 définitivement : sur une ingestion de dix fichiers dont neuf réussissent, la
 suite du plan n'était jamais débloquée et le run restait `running` pour
 toujours. Un incident sur un document devenait une panne totale — le coût
 était sans rapport avec le dégât.

 La barrière s'ouvre donc quand tout le groupe est TERMINAL. Ce que valait
 réellement la garantie « tout est done » est préservé ailleurs, et plus
 finement : une tâche qui dépend explicitement d'une tâche en échec reste
 bloquée par `dependenciesDone`, et le planificateur la marque `skipped`
 (cf. blockedByFailedDependency). On distingue ainsi « la suite ne peut pas se
 faire » de « la suite peut se faire sur ce qui a réussi ».
*/
function groupBarrierSatisfied(task, tasks) {
  const groupId = task?.dependsOnGroup;
  if (groupId == null || groupId === '') return true;
  const groupTasks = tasks.filter((candidate) => taskGroupId(candidate) === String(groupId));
  if (groupTasks.length === 0) return false;
  return groupTasks.every((candidate) => isTerminal(statusOf(candidate)));
}

/**
 * Tâches en attente qui ne deviendront JAMAIS exécutables, parce qu'une de
 * leurs dépendances directes est terminale sans avoir réussi.
 *
 * Sans cette liste, le planificateur ne pouvait que constater « plus aucune
 * tâche prête » et déclarer le plan bloqué — ce qui déclenchait une
 * replanification, donc un run qui ne se termine pas. Les nommer permet de les
 * marquer `skipped` avec leur motif, de finaliser le run sur un résultat
 * partiel, et de dire à l'utilisateur ce qui n'a pas été fait et pourquoi.
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

export function isTerminalTask(task) {
  return isTerminal(statusOf(task));
}
