export function createQueueStore(session, { persist = () => {} } = {}) {
  session.jobQueue ??= [];
  return {
    list() {
      session.jobQueue ??= [];
      return session.jobQueue;
    },
    replace(queue) {
      session.jobQueue = Array.isArray(queue) ? queue : [];
      persist();
      return session.jobQueue;
    },
    changed() {
      session.jobQueue ??= [];
      persist();
    },
  };
}

export function createMemoryQueueStore(session) {
  return createQueueStore(session, { persist: () => session._onQueueUpdate?.(session.jobQueue) });
}

export function queueStoreFor(session) {
  session.queueStore ??= createMemoryQueueStore(session);
  return session.queueStore;
}
