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
  };
}

function planTaskId(task) {
  return String(task?.id ?? task?.step);
}

export { locksForTask };
