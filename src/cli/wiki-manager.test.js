import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forwardRuntimeApproval,
  resolvePreparedDelegationApproval,
} from './wiki-manager.js';

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

test('prepared delegation waits for explicit approval by default', () => {
  let calls = 0;
  const result = resolvePreparedDelegationApproval({
    runId: 'run-gated',
    approvalManager: {
      approve() {
        calls += 1;
      },
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, { approved: false, awaitingApproval: true });
});

test('prepared delegation only approves when autoApprove is explicitly true', () => {
  let forwarded = null;
  const result = resolvePreparedDelegationApproval({
    autoApprove: true,
    runId: 'run-headless',
    approvalManager: {
      approve(request) {
        forwarded = request;
        return { approved: true };
      },
    },
  });

  assert.deepEqual(forwarded, { scope: 'run', runId: 'run-headless' });
  assert.deepEqual(result, {
    approved: true,
    awaitingApproval: false,
    result: { approved: true },
  });
});
