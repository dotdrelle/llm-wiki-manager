import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueProductionJob, ensureJobQueue } from './jobQueue.js';

test('job queue uses an injected queue store', () => {
  const queue = [];
  let changed = 0;
  const session = {
    workspace: 'docs',
    queueStore: {
      list() {
        return queue;
      },
      replace(next) {
        queue.splice(0, queue.length, ...next);
        changed += 1;
        return queue;
      },
      changed() {
        changed += 1;
      },
    },
  };

  const item = enqueueProductionJob(session, { type: 'build' }, 'workspace_busy');

  assert.equal(item.workspace, 'docs');
  assert.match(item.id, /^q-[0-9a-f-]{36}$/);
  assert.equal(queue.length, 1);
  assert.equal(ensureJobQueue(session), queue);
  assert.equal(changed, 1);
});
