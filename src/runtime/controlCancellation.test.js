import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelControlChain, cancelQueuedControlItem } from './controlCancellation.js';

test('run cancellation skips queued siblings of the same chain only', () => {
  const session = { controlQueue: [
    { id: 'a1', runId: 'run-a', chainId: 'a', status: 'running' },
    { id: 'a2', chainId: 'a', status: 'queued' },
    { id: 'b1', chainId: 'b', status: 'queued' },
  ] };
  const result = cancelControlChain(session, { runId: 'run-a', cancelItem: (item) => { item.status = 'skipped'; } });
  assert.equal(result.skipped, 1);
  assert.equal(session.controlQueue[2].status, 'queued');
});

test('targeted cancellation propagates only after a required item', () => {
  const session = { controlQueue: [
    { id: 'a1', chainId: 'a', chainSequence: 0, status: 'queued' },
    { id: 'a2', chainId: 'a', chainSequence: 1, status: 'queued' },
  ] };
  const result = cancelQueuedControlItem(session, 'a1', {
    cancelItem: (item) => { item.status = 'cancelled'; },
    skipItem: (item) => { item.status = 'skipped'; },
  });
  assert.deepEqual({ cancelled: result.cancelled, skipped: result.skipped }, { cancelled: true, skipped: 1 });
});

test('run cancellation of a standalone item never touches the rest of the queue', () => {
  const session = { controlQueue: [
    { id: 'a', runId: 'run-1', status: 'running', optional: false, continueOnFailure: false },
    { id: 'b', status: 'queued', optional: false, continueOnFailure: false },
    { id: 'c', status: 'queued', optional: false, continueOnFailure: false },
  ] };
  const cancelled = [];
  const result = cancelControlChain(session, { runId: 'run-1', cancelItem: (item) => cancelled.push(item.id) });
  assert.deepEqual(cancelled, []);
  assert.equal(result.skipped, 0);
  assert.deepEqual(session.controlQueue.map((item) => item.status), ['running', 'queued', 'queued']);
});

test('run cancellation on an optional active item preserves later chain steps', () => {
  const session = { controlQueue: [
    { id: 'optional', runId: 'run-optional', chainId: 'a', status: 'running', optional: true },
    { id: 'next', chainId: 'a', status: 'queued' },
  ] };
  const result = cancelControlChain(session, { runId: 'run-optional', cancelItem: (item) => { item.status = 'skipped'; } });
  assert.equal(result.skipped, 0);
  assert.equal(session.controlQueue[1].status, 'queued');
});
