import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueProductionJob, ensureJobQueue } from './jobQueue.js';

test('job queue uses an injected queue store', () => {
  const queue = [];
  let changed = 0;
  const session = {
    workspace: 'docs',
    workspacePath: mkdtempSync(join(tmpdir(), 'wiki-manager-queue-')),
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

test('job queue refuses production jobs without an active workspace path', () => {
  assert.throws(
    () => enqueueProductionJob({ workspace: 'docs' }, { type: 'ingest', inputs: ['raw/untracked/*.md'] }),
    /no active workspace path/i,
  );
});

test('job queue normalizes production input paths against workspace path', () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wiki-manager-queue-inputs-'));
  const item = enqueueProductionJob(
    { workspace: 'docs', workspacePath },
    { type: 'ingest', inputs: ['raw/untracked/*.md', join(workspacePath, 'raw', 'untracked', 'doc.md')] },
  );

  assert.deepEqual(item.args.inputs, ['raw/untracked/*.md', 'raw/untracked/doc.md']);
});
