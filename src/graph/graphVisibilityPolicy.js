const ALWAYS_VISIBLE = new Set(['run', 'task_group', 'barrier', 'approval']);
const ACTIVE = new Set(['running', 'queued', 'pending_approval', 'waiting_approval']);
const ERROR = new Set(['failed', 'error', 'cancelled']);

export function applyGraphVisibility(graph, { maxNodes = 18 } = {}) {
  const nodes = graph.nodes ?? [];
  if (nodes.length <= maxNodes) return { ...graph, visibleNodes: nodes, visibleEdges: graph.edges ?? [], aggregations: [] };
  const visible = [];
  const hidden = [];
  for (const node of nodes) {
    if (mustShow(node) || visible.length < maxNodes) visible.push(node);
    else hidden.push(node);
  }
  if (hidden.length > 0) {
    const aggregate = {
      id: 'aggregate:hidden',
      type: 'aggregate',
      label: `${hidden.length} hidden node${hidden.length > 1 ? 's' : ''}`,
      status: 'collapsed',
      raw: { count: hidden.length, nodeIds: hidden.map((node) => node.id) },
    };
    if (visible.length >= maxNodes) visible.pop();
    visible.push(aggregate);
  }
  const ids = new Set(visible.map((node) => node.id));
  return {
    ...graph,
    visibleNodes: visible,
    visibleEdges: (graph.edges ?? []).filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    aggregations: hidden.length > 0 ? [{ id: 'aggregate:hidden', count: hidden.length }] : [],
  };
}

function mustShow(node) {
  const status = String(node.status ?? '').toLowerCase();
  return ALWAYS_VISIBLE.has(node.type)
    || ACTIVE.has(status)
    || ERROR.has(status)
    || node.type === 'plan_expansion';
}
