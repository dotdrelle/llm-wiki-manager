import test from 'node:test';
import assert from 'node:assert/strict';
import { applySkipPropagation, reconcileControlQueue } from './controlDrain.js';

test('drain starts only the first runnable chain item', async () => {
  const started = [];
  const context = { running: false, session: { controlQueue: [
    { id: 'a1', chainId: 'a', chainSequence: 0, status: 'queued' },
    { id: 'a2', chainId: 'a', chainSequence: 1, status: 'queued' },
  ] } };
  assert.equal(await reconcileControlQueue(context, { startItem: (item) => { started.push(item.id); context.running = true; } }), true);
  assert.deepEqual(started, ['a1']);
});

test('failed required predecessors skip remaining items but preserve another chain', () => {
  const queue = [
    { id: 'a1', chainId: 'a', chainSequence: 0, status: 'failed' },
    { id: 'a2', chainId: 'a', chainSequence: 1, status: 'queued' },
    { id: 'b1', chainId: 'b', chainSequence: 0, status: 'queued' },
  ];
  const skipped = [];
  applySkipPropagation(queue, (item) => { item.status = 'skipped'; skipped.push(item.id); });
  assert.deepEqual(skipped, ['a2']);
  assert.equal(queue[2].status, 'queued');
});
