import { createQueueStore } from '../core/queueStore.js';

export function createSqliteQueueStore(store, session, { workspace = session.workspace ?? null } = {}) {
  session.jobQueue = store.listQueue({ workspace });
  return createQueueStore(session, { persist: () => store.saveQueue(session.jobQueue, { workspace }) });
}
