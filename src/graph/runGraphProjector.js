export function projectRunGraph(workflow = {}, events = []) {
  const nodes = new Map();
  const edges = [];
  for (const node of workflow.nodes ?? []) addNode(nodes, graphNodeFromWorkflow(node));
  for (const relation of workflow.relations ?? []) edges.push({ ...relation });
  for (const event of events ?? []) projectEvent(event, nodes, edges);
  return { nodes: [...nodes.values()], edges };
}

function projectEvent(event, nodes, edges) {
  const runId = event.runId ?? event.payload?.runId ?? null;
  const taskId = event.taskId ?? event.payload?.taskId ?? null;
  if (event.type === 'task_group.created') {
    const group = event.payload?.group ?? {};
    addNode(nodes, {
      id: `group:${group.id}`,
      type: 'task_group',
      label: group.label ?? group.id,
      status: 'pending',
      raw: group,
    });
    if (runId) edges.push({ type: 'contains', from: `run:${runId}`, to: `group:${group.id}` });
  }
  if (event.type === 'task.created') {
    const task = event.payload?.task ?? {};
    if (task.groupId) edges.push({ type: 'in_group', from: `task:${task.id ?? taskId}`, to: `group:${task.groupId}` });
    if (task.barrier || task.dependsOnGroup) {
      const id = `barrier:${task.dependsOnGroup ?? task.groupId ?? task.id ?? taskId}`;
      addNode(nodes, { id, type: 'barrier', label: `Barrier ${task.dependsOnGroup ?? task.groupId ?? ''}`.trim(), status: task.status ?? 'pending', raw: task });
      edges.push({ type: 'barrier_for', from: id, to: `task:${task.id ?? taskId}` });
    }
  }
  if (event.type === 'task.assigned') {
    const assignment = event.payload?.assignment ?? {};
    const assignmentId = `assignment:${taskId}:${event.payload?.attemptId ?? assignment.attemptId ?? 'current'}`;
    addNode(nodes, { id: assignmentId, type: 'assignment', label: assignment.agentInstanceId ?? 'Assignment', status: 'done', raw: assignment });
    addNode(nodes, { id: `agent:${assignment.agentInstanceId}`, type: 'agent_instance', label: assignment.agentInstanceId ?? 'Agent', status: 'available', raw: assignment.agent ?? {} });
    edges.push({ type: 'assigned_to', from: `task:${taskId}`, to: assignmentId });
    edges.push({ type: 'uses_agent', from: assignmentId, to: `agent:${assignment.agentInstanceId}` });
  }
  if (['task.started', 'task.retry_scheduled'].includes(event.type)) {
    const attemptId = event.payload?.attemptId ?? event.payload?.retryAssignment?.attemptId ?? `${taskId}:attempt`;
    addNode(nodes, { id: `attempt:${attemptId}`, type: 'attempt', label: String(attemptId), status: event.type === 'task.retry_scheduled' ? 'retry_scheduled' : 'running', raw: event.payload ?? {} });
    edges.push({ type: 'attempt_of', from: `attempt:${attemptId}`, to: `task:${taskId}` });
  }
  if (['task.result_returned', 'task.completed', 'task.failed'].includes(event.type)) {
    const result = event.payload?.result ?? {};
    const attemptId = result.attemptId ?? event.payload?.attemptId ?? `${taskId}:attempt`;
    const resultId = `result:${attemptId}`;
    addNode(nodes, { id: resultId, type: 'result', label: result.status ?? event.type, status: event.type === 'task.failed' ? 'failed' : 'done', raw: result });
    edges.push({ type: 'result_of', from: resultId, to: `attempt:${attemptId}` });
  }
  if (event.type === 'plan.revision_changed' && event.payload?.previousRevision != null) {
    const id = `plan_expansion:${runId}:${event.payload.planRevision}`;
    addNode(nodes, { id, type: 'plan_expansion', label: `Plan revision ${event.payload.planRevision}`, status: 'done', raw: event.payload });
    if (runId) edges.push({ type: 'expands', from: id, to: `run:${runId}` });
  }
}

function graphNodeFromWorkflow(node) {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    status: node.status,
    tooltip: tooltipFor(node),
    raw: node.raw ?? node,
  };
}

function tooltipFor(node) {
  if (node.type !== 'task') return `${node.type}: ${node.label}`;
  const raw = node.raw ?? {};
  return [
    `Tache : ${node.label}`,
    raw.requiredCapability ? `Capacite : ${raw.requiredCapability}` : null,
    raw.agentInstanceId ? `Agent : ${raw.agentInstanceId}` : null,
    raw.retryState?.attempts ? `Tentative : ${raw.retryState.attempts}` : null,
    `Etat : ${node.status}`,
    node.progress?.percent != null ? `Progression : ${Math.round(Number(node.progress.percent))} %` : null,
  ].filter(Boolean).join('\n');
}

function addNode(nodes, node) {
  if (!node?.id) return;
  nodes.set(node.id, { ...(nodes.get(node.id) ?? {}), ...node });
}
