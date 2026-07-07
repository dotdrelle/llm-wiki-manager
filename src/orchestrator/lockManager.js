export function createLockManager({ locks = new Set() } = {}) {
  return {
    canAcquire(taskOrLocks) {
      return locksFor(taskOrLocks).every((lock) => !locks.has(lock));
    },
    acquire(taskOrLocks) {
      const lockNames = locksFor(taskOrLocks);
      if (lockNames.some((lock) => locks.has(lock))) return null;
      for (const lock of lockNames) locks.add(lock);
      let released = false;
      return {
        locks: lockNames,
        release() {
          if (released) return;
          released = true;
          for (const lock of lockNames) locks.delete(lock);
        },
      };
    },
    release(taskOrLocks) {
      for (const lock of locksFor(taskOrLocks)) locks.delete(lock);
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

function locksFor(taskOrLocks) {
  if (Array.isArray(taskOrLocks)) return [...new Set(taskOrLocks.map(String).filter(Boolean))].sort();
  return locksForTask(taskOrLocks);
}
