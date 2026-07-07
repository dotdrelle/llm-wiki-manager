export function createAttemptManager({ locks = new Set() } = {}) {
  let nextAttempt = 0;
  return {
    reserve(task, requestedLocks = locksForTask(task)) {
      const taskId = planTaskId(task);
      const lockNames = [...new Set((requestedLocks ?? []).map(String).filter(Boolean))].sort();
      if (lockNames.some((lock) => locks.has(lock))) return null;
      for (const lock of lockNames) locks.add(lock);
      let released = false;
      nextAttempt += 1;
      return {
        taskId,
        attemptId: `${taskId}:attempt-${nextAttempt}`,
        locks: lockNames,
        release() {
          if (released) return;
          released = true;
          for (const lock of lockNames) locks.delete(lock);
        },
      };
    },
    clear() {
      locks.clear();
    },
    snapshot() {
      return [...locks].sort();
    },
  };
}

export function locksForTask(task) {
  const locks = new Set();
  const explicit = task?.locks ?? task?.writeLocks ?? null;
  if (Array.isArray(explicit)) {
    for (const lock of explicit) if (lock) locks.add(String(lock));
  } else if (explicit && typeof explicit === 'object') {
    if (explicit.workspaceWrite || explicit.workspace) locks.add('workspace:write');
    for (const value of explicit.deliverableWrites ?? explicit.deliverables ?? []) locks.add(`deliverable:${value}`);
    for (const value of explicit.wikiPageWrites ?? explicit.wikiPages ?? []) locks.add(`wiki-page:${value}`);
  }
  for (const value of task?.deliverableWrites ?? []) locks.add(`deliverable:${value}`);
  for (const value of task?.wikiPageWrites ?? []) locks.add(`wiki-page:${value}`);
  if (task?.workspaceWrite) locks.add('workspace:write');
  return [...locks].sort();
}

function planTaskId(task) {
  return String(task?.id ?? task?.step);
}
