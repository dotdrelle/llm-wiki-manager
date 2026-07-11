import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardRuntimeApproval } from './wiki-manager.js';

test('runtime approval bridge preserves the complete run-scoped grant', async () => {
  let forwarded = null;
  const request = {
    workspace: 'test4',
    workspaceId: 'test4',
    runId: 'run-1',
    scope: 'run',
    planRevision: 3,
    approvalClasses: ['mutation'],
  };

  const result = await forwardRuntimeApproval(async (workspace) => ({
    approvalManager: {
      approve(value) {
        assert.equal(workspace, 'test4');
        forwarded = value;
        return { approved: true };
      },
    },
  }), request);

  assert.deepEqual(forwarded, request);
  assert.deepEqual(result, { approved: true });
});
