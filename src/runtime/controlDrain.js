/**
 * @statuses-vocabulary
 * Control items are queued run requests, not orchestrator tasks. Their
 * terminal vocabulary deliberately includes chain-level `skipped` and is
 * projected by core/agentEvents.js rather than taskStatuses.js.
 */
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'skipped']);

export function reconcileControlQueue(context, { startItem, skipItem } = {}) {
  if (!context?.session || context.running || context.controlDrainActive) return false;
  context.controlDrainActive = true;
  try {
    const queue = Array.isArray(context.session.controlQueue) ? context.session.controlQueue : [];
    applySkipPropagation(queue, skipItem);
    // Event dispatch replaces the projection array and its objects. Re-read it
    // after propagation so eligibility never runs against stale queued items.
    const refreshed = Array.isArray(context.session.controlQueue) ? context.session.controlQueue : [];
    const next = refreshed.find((item) => isRunnableControlItem(item, refreshed));
    if (!next) return false;
    startItem?.(next);
    return true;
  } finally {
    context.controlDrainActive = false;
  }
}

export function isRunnableControlItem(item, queue) {
  if (item?.status !== 'queued') return false;
  if (!item.chainId) return true;
  const predecessors = queue.filter((candidate) => candidate.chainId === item.chainId && Number(candidate.chainSequence) < Number(item.chainSequence));
  if (predecessors.some((candidate) => !TERMINAL.has(candidate.status))) return false;
  return !predecessors.some((candidate) => candidate.optional !== true && candidate.continueOnFailure !== true && ['failed', 'cancelled', 'skipped'].includes(candidate.status));
}

export function applySkipPropagation(queue, skipItem = null) {
  let changed = 0;
  for (const item of queue) {
    if (item.status !== 'queued' || !item.chainId) continue;
    const predecessors = queue.filter((candidate) => candidate.chainId === item.chainId && Number(candidate.chainSequence) < Number(item.chainSequence));
    const blocker = predecessors.find((candidate) => candidate.optional !== true && candidate.continueOnFailure !== true && ['failed', 'cancelled', 'skipped'].includes(candidate.status));
    if (!blocker) continue;
    skipItem?.(item, blocker.status === 'cancelled' ? 'chain_cancelled' : 'required_predecessor_failed');
    // Event dispatch replaces the projected queue instead of mutating this
    // snapshot. Mirror the transition locally so later siblings in this same
    // pass can observe the cascade (failed -> skipped -> skipped).
    item.status = 'skipped';
    changed += 1;
  }
  return changed;
}
