import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { createLockManager, locksForTask } from './lockManager.js';

export function createAttemptManager({ locks = new Set() } = {}) {
  let nextAttempt = 0;
  const lockManager = createLockManager({ locks });
  return {
    reserve(task, requestedLocks = locksForTask(task)) {
      const taskId = planTaskId(task);
      const reservation = lockManager.acquire(requestedLocks);
      if (!reservation) return null;
      nextAttempt += 1;
      return {
        taskId,
        attemptId: `${taskId}:attempt-${nextAttempt}`,
        locks: reservation.locks,
        release: reservation.release,
      };
    },
    clear() {
      lockManager.clear();
    },
    snapshot() {
      return lockManager.snapshot();
    },
    canAcquire(task) {
      return lockManager.canAcquire(task);
    },
    scheduleRetry(task, failure, options = {}) {
      return scheduleRetry(task, failure, options);
    },
  };
}

export function scheduleRetry(task, failure, {
  assignment = null,
  registry = null,
  session = null,
  runId = null,
  store = null,
} = {}) {
  const retryPolicy = task?.retryPolicy;
  if (!retryPolicy || !retryableFailure(failure, retryPolicy)) return { scheduled: false, reason: 'not_retryable' };
  const attempts = currentAttempts(task);
  if (attempts >= Number(retryPolicy.maxAttempts)) {
    return { scheduled: false, reason: 'max_attempts_reached', attempts };
  }

  const previousAgentInstanceId = assignment?.agentInstanceId ?? failure?.result?.agentInstanceId ?? failure?.agentInstanceId ?? null;
  let nextAgentInstanceId = previousAgentInstanceId;
  if (retryPolicy.allowAgentFallback === true) {
    const fallback = fallbackProvider(task, {
      registry,
      previousAgentInstanceId,
    });
    if (!fallback) return { scheduled: false, reason: 'no_compatible_fallback', attempts };
    nextAgentInstanceId = fallback.agentInstanceId;
  }

  const nextAttempts = attempts + 1;
  const retryAssignment = nextAgentInstanceId ? {
    agentInstanceId: nextAgentInstanceId,
    previousAgentInstanceId,
    contractVersion: contractVersionFor(registry, task.requiredCapability, nextAgentInstanceId),
  } : null;
  const payload = {
    runId,
    taskId: planTaskId(task),
    previousAgentInstanceId,
    newAgentInstanceId: nextAgentInstanceId,
    attempts: nextAttempts,
    maxAttempts: retryPolicy.maxAttempts,
    retryAssignment,
    error: failure?.result?.error ?? failure?.error ?? null,
  };
  if (session) {
    persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('task.retry_scheduled', {
      origin: 'attempt_manager',
      runId,
      taskId: planTaskId(task),
      payload,
    })));
    persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
      origin: 'attempt_manager',
      runId,
      taskId: planTaskId(task),
      payload: {
        taskId: planTaskId(task),
        status: 'pending',
        retryState: {
          attempts: nextAttempts,
          previousAgentInstanceId,
          agentInstanceId: nextAgentInstanceId,
        },
        retryAssignment,
      },
    })));
  }
  return {
    scheduled: true,
    attempts: nextAttempts,
    previousAgentInstanceId,
    newAgentInstanceId: nextAgentInstanceId,
    retryAssignment,
  };
}

function retryableFailure(failure, retryPolicy) {
  const error = failure?.result?.error ?? failure?.error ?? {};
  if (error?.retryable !== true) return false;
  const retryableErrors = Array.isArray(retryPolicy.retryableErrors) ? retryPolicy.retryableErrors.map(String) : [];
  if (retryableErrors.length === 0 || retryableErrors.includes('*')) return true;
  const code = String(error.code ?? '');
  return code ? retryableErrors.includes(code) : true;
}

function currentAttempts(task) {
  const value = Number(task?.retryState?.attempts ?? task?.attempts ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function fallbackProvider(task, { registry, previousAgentInstanceId }) {
  if (!registry || typeof registry.providersFor !== 'function') return null;
  const previous = providerFor(registry, task.requiredCapability, previousAgentInstanceId);
  const previousContractVersion = previous ? contractVersion(previous) : null;
  const previousCapabilityVersion = previous?.capability?.version ?? null;
  return (registry.providersFor(task.requiredCapability) ?? [])
    .filter((provider) => provider.agentInstanceId !== previousAgentInstanceId)
    .filter((provider) => compatibleProvider(provider, registry, { previousContractVersion, previousCapabilityVersion, operation: task.operation }))
    .sort((a, b) => String(a.agentInstanceId).localeCompare(String(b.agentInstanceId)))[0] ?? null;
}

function compatibleProvider(provider, registry, { previousContractVersion, previousCapabilityVersion, operation }) {
  const providerContractVersion = contractVersion(provider);
  if (previousContractVersion && providerContractVersion !== previousContractVersion) return false;
  if (previousCapabilityVersion && provider?.capability?.version !== previousCapabilityVersion) return false;
  if (typeof registry.isCompatible === 'function' && !registry.isCompatible(providerContractVersion)) return false;
  const health = String(provider?.health ?? provider?.description?.health?.status ?? '');
  if (!['available', 'degraded'].includes(health)) return false;
  if (provider?.available === false || provider?.availability === 'unavailable') return false;
  const operations = provider?.capability?.supportedOperations ?? [];
  return !operation || operations.length === 0 || operations.includes(operation);
}

function providerFor(registry, capability, agentInstanceId) {
  if (!agentInstanceId || typeof registry?.providersFor !== 'function') return null;
  return (registry.providersFor(capability) ?? [])
    .find((provider) => provider.agentInstanceId === agentInstanceId) ?? null;
}

function contractVersionFor(registry, capability, agentInstanceId) {
  const provider = providerFor(registry, capability, agentInstanceId);
  return provider ? contractVersion(provider) : null;
}

function contractVersion(provider) {
  return String(provider?.description?.contractVersion ?? provider?.contractVersion ?? '');
}

function persistDispatch(store, event) {
  store?.persistEvent?.(event);
}

function planTaskId(task) {
  return String(task?.id ?? task?.step);
}

export { locksForTask };
