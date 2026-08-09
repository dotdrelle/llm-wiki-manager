export function cancelControlChain(session, { runId = null, itemId = null, reason = 'chain_cancelled', cancelItem } = {}) {
  const queue = Array.isArray(session?.controlQueue) ? session.controlQueue : [];
  const active = queue.find((item) => (itemId && item.id === itemId) || (runId && item.runId === runId));
  if (!active) return { active: null, skipped: 0 };
  // A standalone control item carries no chainId at all. Without this guard the
  // sibling test below compares undefined to undefined, matches every queued
  // standalone request, and turns `/run cancel` into a full queue wipe.
  if (!active.chainId) return { active, skipped: 0 };
  if (active.optional === true || active.continueOnFailure === true) return { active, skipped: 0 };
  let skipped = 0;
  for (const item of queue) {
    if (item.id === active.id || item.chainId !== active.chainId || item.status !== 'queued') continue;
    cancelItem?.(item, reason);
    skipped += 1;
  }
  return { active, skipped };
}

export function cancelQueuedControlItem(session, itemId, { cancelItem, skipItem } = {}) {
  const queue = Array.isArray(session?.controlQueue) ? session.controlQueue : [];
  const item = queue.find((entry) => String(entry.id) === String(itemId));
  if (!item || item.status !== 'queued') return { cancelled: false, reason: item ? 'not_queued' : 'not_found' };
  cancelItem?.(item, 'item_cancelled');
  let skipped = 0;
  if (item.chainId && item.optional !== true && item.continueOnFailure !== true) {
    for (const sibling of queue) {
      if (sibling.chainId !== item.chainId || sibling.status !== 'queued' || Number(sibling.chainSequence) <= Number(item.chainSequence)) continue;
      skipItem?.(sibling, 'required_predecessor_cancelled');
      skipped += 1;
    }
  }
  return { cancelled: true, item, skipped };
}
