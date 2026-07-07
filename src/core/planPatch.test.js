import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPlanPatch, nextReadyPlanTask, normalizeTask, readyPlanTasks, rebasePlanPatch, sanitizePlanForExecution } from './planPatch.js';

test('applyPlanPatch adds a task and increments the plan revision', () => {
  const result = applyPlanPatch([
    { step: 1, id: 'task-a', description: 'A', status: 'done' },
  ], {
    basePlanRevision: 4,
    operations: [{
      op: 'add_task',
      task: {
        id: 'task-b',
        description: 'B',
        dependsOn: ['task-a'],
        executorQuery: { capability: 'build' },
      },
    }],
  }, { currentRevision: 4 });

  assert.equal(result.ok, true);
  assert.equal(result.planRevision, 5);
  assert.equal(result.plan[1].id, 'task-b');
  assert.deepEqual(result.plan[1].dependsOn, ['task-a']);
  assert.deepEqual(result.plan[1].executorQuery, { capability: 'build' });
});

test('applyPlanPatch rejects stale revisions for explicit rebase', () => {
  const patch = { basePlanRevision: 2, operations: [] };
  const result = applyPlanPatch([], patch, { currentRevision: 3 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revision_mismatch');
  assert.deepEqual(rebasePlanPatch(patch, { currentRevision: 3 }), {
    basePlanRevision: 3,
    operations: [],
    rebasedFromRevision: 2,
  });
});

test('readyPlanTasks returns pending tasks whose dependencies are done', () => {
  const plan = [
    { step: 1, id: 'a', description: 'A', status: 'done' },
    { step: 2, id: 'b', description: 'B', status: 'pending', dependsOn: ['a'] },
    { step: 3, id: 'c', description: 'C', status: 'pending', dependsOn: ['b'] },
  ];

  assert.deepEqual(readyPlanTasks(plan).map((task) => task.id), ['b']);
  assert.equal(nextReadyPlanTask(plan).id, 'b');
});

test('applyPlanPatch rejects dependency cycles', () => {
  const result = applyPlanPatch([
    { step: 1, id: 'a', description: 'A', status: 'pending', dependsOn: ['b'] },
    { step: 2, id: 'b', description: 'B', status: 'pending' },
  ], {
    basePlanRevision: 0,
    operations: [{ op: 'add_dependency', taskId: 'b', dependencyId: 'a' }],
  }, { currentRevision: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dependency_cycle');
});

test('sanitizePlanForExecution removes unknown dependencies and keeps execution sequential', () => {
  const result = sanitizePlanForExecution([
    { step: 1, id: 'a', description: 'A', status: 'pending', dependsOn: ['missing'] },
    { step: 2, id: 'b', description: 'B', status: 'pending', dependsOn: ['a'] },
  ]);

  assert.deepEqual(result.plan.map((task) => task.dependsOn), [[], ['a']]);
  assert.match(result.warnings.join('\n'), /unknown dependency/);
  assert.deepEqual(readyPlanTasks(result.plan).map((task) => task.id), ['a']);
});

test('sanitizePlanForExecution breaks cycles with declaration-order fallback', () => {
  const result = sanitizePlanForExecution([
    { step: 1, id: 'a', description: 'A', status: 'pending', dependsOn: ['b'] },
    { step: 2, id: 'b', description: 'B', status: 'pending', dependsOn: ['a'] },
  ]);

  assert.deepEqual(result.plan.map((task) => task.dependsOn), [[], ['a']]);
  assert.match(result.warnings.join('\n'), /cycle/);
  assert.deepEqual(readyPlanTasks(result.plan).map((task) => task.id), ['a']);
});

test('normalizeTask carries task contract fields with safe defaults', () => {
  const task = normalizeTask({
    id: 'ingest-a',
    label: 'Ingest A',
    requiredCapability: 'knowledge.update',
    operation: 'ingest',
    arguments: { files: ['raw/untracked/a.md'] },
    groupId: 'ingest',
    dependsOn: ['scan'],
    dependsOnGroup: 'sources',
    barrier: true,
    parallelizable: true,
    recommendedConcurrency: 3,
    inputRefs: [{ type: 'file', ref: 'raw/untracked/a.md' }],
    expectedOutputRefs: ['wiki/a.md'],
    locks: ['workspace:wiki'],
    requiresApproval: true,
    approvalClass: 'mutation',
    approvalSummary: 'Update wiki',
    idempotencyKey: 'idem-1',
    progressWeight: 2,
    priority: 5,
    retryPolicy: {
      maxAttempts: 2,
      retryableErrors: ['timeout'],
      allowAgentFallback: true,
    },
  }, 0);

  assert.equal(task.description, 'Ingest A');
  assert.equal(task.parallelizable, true);
  assert.deepEqual(task.inputRefs, [{ type: 'file', ref: 'raw/untracked/a.md' }]);
  assert.deepEqual(task.expectedOutputRefs, ['wiki/a.md']);
  assert.deepEqual(task.locks, ['workspace:wiki']);
  assert.equal(task.requiresApproval, true);
  assert.equal(task.progressWeight, 2);
  assert.deepEqual(task.retryPolicy, {
    maxAttempts: 2,
    retryableErrors: ['timeout'],
    allowAgentFallback: true,
  });
});

test('normalizeTask supplies safe defaults for new execution fields', () => {
  const task = normalizeTask({ id: 'legacy', description: 'Legacy task' }, 0);

  assert.equal(task.label, 'Legacy task');
  assert.equal(task.requiredCapability, null);
  assert.equal(task.operation, null);
  assert.deepEqual(task.arguments, {});
  assert.equal(task.parallelizable, false);
  assert.deepEqual(task.inputRefs, []);
  assert.deepEqual(task.locks, []);
  assert.equal(task.requiresApproval, false);
  assert.equal(task.idempotencyKey, null);
  assert.equal(task.progressWeight, 1);
});

test('sanitizePlanForExecution preserves task contract fields through cleanup', () => {
  const result = sanitizePlanForExecution([
    {
      id: 'scan',
      label: 'Scan inputs',
      requiredCapability: 'knowledge.update',
      operation: 'scan',
      dependsOn: [],
      parallelizable: false,
      inputRefs: [{ type: 'directory', ref: 'raw/untracked' }],
      locks: [],
      requiresApproval: false,
      idempotencyKey: null,
      progressWeight: 1,
    },
    {
      id: 'ingest',
      label: 'Ingest inputs',
      requiredCapability: 'knowledge.update',
      operation: 'ingest',
      dependsOn: ['scan', 'missing'],
      parallelizable: true,
      inputRefs: ['raw/untracked/a.md'],
      locks: ['workspace:wiki'],
      requiresApproval: false,
      idempotencyKey: null,
      progressWeight: 3,
    },
  ]);

  assert.deepEqual(result.plan[1].dependsOn, ['scan']);
  assert.equal(result.plan[1].requiredCapability, 'knowledge.update');
  assert.equal(result.plan[1].operation, 'ingest');
  assert.equal(result.plan[1].parallelizable, true);
  assert.deepEqual(result.plan[1].inputRefs, ['raw/untracked/a.md']);
  assert.deepEqual(result.plan[1].locks, ['workspace:wiki']);
  assert.equal(result.plan[1].progressWeight, 3);
});

test('legacy event plan replay remains readable after task contract extension', () => {
  const result = sanitizePlanForExecution([
    { step: 1, id: 'a', description: 'Old A', status: 'done' },
    { step: 2, id: 'b', description: 'Old B', status: 'pending', dependsOn: ['a'] },
  ]);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.plan.map((task) => task.id), ['a', 'b']);
  assert.deepEqual(result.plan.map((task) => task.label), ['Old A', 'Old B']);
  assert.deepEqual(readyPlanTasks(result.plan).map((task) => task.id), ['b']);
});
