import { createGraphSnapshot } from './graphSnapshot.js';

export function aggregateGraph(workflow = {}, events = [], options = {}) {
  return createGraphSnapshot(workflow, events, options);
}
