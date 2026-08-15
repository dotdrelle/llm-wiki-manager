import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalManager } from './approvals.js';

test('approve() refuses an unbounded run-scope grant', () => {
  const manager = createApprovalManager({ workspace: 'docs' });
  const result = manager.approve({ scope: 'run' });

  assert.equal(result.approved, false);
  assert.equal(result.reason, 'run_scope_requires_runId');
});

test('approve() bounds a bare run-scope grant to the active run identity', () => {
  const manager = createApprovalManager({
    workspace: 'docs',
    _currentRunIdentity: { runId: 'run-1', workspace: 'docs' },
  });
  const result = manager.approve({ scope: 'run' });

  assert.equal(result.approved, true);
  assert.equal(result.runId, 'run-1');
  assert.equal(result.scope, 'run');
});

test('approve() keeps an explicit runId even without a live run identity', () => {
  const manager = createApprovalManager({ workspace: 'docs' });
  const result = manager.approve({ scope: 'run', runId: 'run-2' });

  assert.equal(result.approved, true);
  assert.equal(result.runId, 'run-2');
});

test('approve() leaves task/tool/group grants unblocked by the run guard', () => {
  const manager = createApprovalManager({ workspace: 'docs' });

  const task = manager.approve({ scope: 'task', taskId: 'run-1:build' });
  assert.equal(task.approved, true);
  assert.equal(task.scope, 'task');

  const group = manager.approve({ scope: 'group', groupId: 'publish' });
  assert.equal(group.approved, true);
  assert.equal(group.scope, 'group');
});
