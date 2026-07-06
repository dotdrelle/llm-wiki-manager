import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPlanPatch, nextReadyPlanTask, readyPlanTasks, rebasePlanPatch, sanitizePlanForExecution } from './planPatch.js';

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
