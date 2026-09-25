/*
 One registry per WORKSPACE, not per run.

 The registry used to be created by each run's attemptManager, so its locks
 only ever excluded tasks of the same run. That was harmless while a
 workspace ran one run at a time, but anything acting beside a run — a
 direct write from a chat turn, a second run — held nothing the first one
 could see. `workspaceLockRegistry` hangs one registry on the workspace
 session; every run and every direct action shares it
 (plan-demandes-pendant-run.md, lot 2). `owners` records who holds each lock
 so a wait can name its holder instead of stalling in silence.
*/
export function workspaceLockRegistry(session) {
  if (!session) return { locks: new Set(), owners: new Map() };
  session._workspaceLocks ??= { locks: new Set(), owners: new Map() };
  return session._workspaceLocks;
}

export function createLockManager({ locks = new Set(), owners = new Map() } = {}) {
  return {
    canAcquire(taskOrLocks) {
      return locksFor(taskOrLocks).every((lock) => !locks.has(lock));
    },
    acquire(taskOrLocks, owner = null) {
      const lockNames = locksFor(taskOrLocks);
      if (lockNames.some((lock) => locks.has(lock))) return null;
      for (const lock of lockNames) {
        locks.add(lock);
        if (owner != null) owners.set(lock, owner);
      }
      let released = false;
      return {
        locks: lockNames,
        release() {
          if (released) return;
          released = true;
          for (const lock of lockNames) {
            locks.delete(lock);
            owners.delete(lock);
          }
        },
      };
    },
    release(taskOrLocks) {
      for (const lock of locksFor(taskOrLocks)) {
        locks.delete(lock);
        owners.delete(lock);
      }
    },
    // Who holds the locks a task would need: [{ lock, owner }], owner null
    // when the holder did not name itself.
    holders(taskOrLocks) {
      return locksFor(taskOrLocks)
        .filter((lock) => locks.has(lock))
        .map((lock) => ({ lock, owner: owners.get(lock) ?? null }));
    },
    clear() {
      locks.clear();
      owners.clear();
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
