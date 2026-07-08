export function diffGraphSnapshots(before = {}, after = {}) {
  const beforeNodes = new Map((before.nodes ?? []).map((node) => [node.id, node]));
  const afterNodes = new Map((after.nodes ?? []).map((node) => [node.id, node]));
  const addedNodes = [...afterNodes.values()].filter((node) => !beforeNodes.has(node.id));
  const removedNodes = [...beforeNodes.values()].filter((node) => !afterNodes.has(node.id));
  const updatedNodes = [...afterNodes.values()].filter((node) => beforeNodes.has(node.id) && JSON.stringify(beforeNodes.get(node.id)) !== JSON.stringify(node));
  return { addedNodes, removedNodes, updatedNodes };
}
