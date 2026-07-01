import { createQueueStore } from '../core/queueStore.js';

export function createSqliteQueueStore(store, session) {
  session.jobQueue = store.listQueue();
  return createQueueStore(session, { persist: () => store.saveQueue(session.jobQueue) });
}
