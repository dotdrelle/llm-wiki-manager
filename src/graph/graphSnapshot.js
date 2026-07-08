import { projectRunGraph } from './runGraphProjector.js';
import { applyGraphVisibility } from './graphVisibilityPolicy.js';

export function createGraphSnapshot(workflow = {}, events = [], options = {}) {
  const graph = projectRunGraph(workflow, events);
  const visible = applyGraphVisibility(graph, options);
  return {
    nodes: graph.nodes,
    edges: graph.edges,
    visibleNodes: visible.visibleNodes,
    visibleEdges: visible.visibleEdges,
    aggregations: visible.aggregations,
  };
}
