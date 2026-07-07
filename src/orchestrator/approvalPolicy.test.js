import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyApprovalCoverage,
  approvalCovered,
  normalizeApprovalGrant,
} from './approvalPolicy.js';

function task(overrides = {}) {
  return {
    id: 'run-1:build',
    groupId: 'build',
    requiresApproval: true,
    approvalClass: 'workspace-write',
    status: 'pending',
    ...overrides,
  };
}

test('approvalPolicy: approve all is bounded to run, workspace, revision and classes', () => {
  const grant = normalizeApprovalGrant({
    scope: 'run',
    runId: 'run-1',
    workspaceId: 'docs',
    planRevision: 2,
    approvalClasses: ['workspace-write'],
  });

  assert.equal(approvalCovered(task(), [grant], { runId: 'run-1', workspaceId: 'docs', planRevision: 2 }), true);
  assert.equal(approvalCovered(task(), [grant], { runId: 'run-2', workspaceId: 'docs', planRevision: 2 }), false);
  assert.equal(approvalCovered(task(), [grant], { runId: 'run-1', workspaceId: 'docs', planRevision: 3 }), false);
  assert.equal(approvalCovered(task({ approvalClass: 'publish' }), [grant], { runId: 'run-1', workspaceId: 'docs', planRevision: 2 }), false);
});

test('approvalPolicy: task and group grants cover only their target scope', () => {
  const taskGrant = normalizeApprovalGrant({
    scope: 'task',
    runId: 'run-1',
    workspaceId: 'docs',
    planRevision: 1,
    taskId: 'run-1:build',
    approvalClasses: ['workspace-write'],
  });
  const groupGrant = normalizeApprovalGrant({
    scope: 'group',
    runId: 'run-1',
    workspaceId: 'docs',
    planRevision: 1,
    groupId: 'publish',
    approvalClasses: ['workspace-write'],
  });

  assert.equal(approvalCovered(task(), [taskGrant], { runId: 'run-1', workspaceId: 'docs', planRevision: 1 }), true);
  assert.equal(approvalCovered(task({ id: 'run-1:other' }), [taskGrant], { runId: 'run-1', workspaceId: 'docs', planRevision: 1 }), false);
  assert.equal(approvalCovered(task({ groupId: 'publish' }), [groupGrant], { runId: 'run-1', workspaceId: 'docs', planRevision: 1 }), true);
  assert.equal(approvalCovered(task({ groupId: 'build' }), [groupGrant], { runId: 'run-1', workspaceId: 'docs', planRevision: 1 }), false);
});

test('approvalPolicy: uncovered approved tasks become waiting_approval requests', () => {
  const tasks = [task({ id: 'run-1:a' }), task({ id: 'run-1:b', approvalClass: 'publish' })];
  const requests = applyApprovalCoverage(tasks, {
    runId: 'run-1',
    workspaceId: 'docs',
    planRevision: 1,
    approvals: [normalizeApprovalGrant({
      scope: 'run',
      runId: 'run-1',
      workspaceId: 'docs',
      planRevision: 1,
      approvalClasses: ['workspace-write'],
    })],
  });

  assert.deepEqual(tasks.map((item) => item.status), ['pending', 'waiting_approval']);
  assert.deepEqual(requests.map((request) => request.taskId), ['run-1:b']);
  assert.deepEqual(requests[0].approvalClasses, ['publish']);
});
