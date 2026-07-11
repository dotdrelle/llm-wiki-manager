import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createBudgetManager } from './budgetManager.js';
import { readyTasks } from './dependencyResolver.js';
import { createLockManager } from './lockManager.js';
import {
  effectiveConcurrency,
  resolveCapabilityConcurrency,
  resolvePlanConcurrency,
  startReadyTasks,
} from './scheduler.js';

test('dependencyResolver holds a barrier task until its dependsOnGroup is done', () => {
  const plan = [
    task('ingest-a', { groupId: 'ingest', status: 'done' }),
    task('ingest-b', { groupId: 'ingest', status: 'pending' }),
    task('consolidate', { dependsOnGroup: 'ingest', priority: 1 }),
  ];

  assert.deepEqual(readyTasks(plan).map((item) => item.id), ['ingest-b']);
  plan[1].status = 'done';
  assert.deepEqual(readyTasks(plan).map((item) => item.id), ['consolidate']);
});

test('dependencyResolver orders ready tasks by priority before step', () => {
  const plan = [
    task('low', { step: 1, priority: 20 }),
    task('high', { step: 2, priority: 5 }),
    task('none', { step: 0 }),
  ];

  assert.deepEqual(readyTasks(plan).map((item) => item.id), ['high', 'low', 'none']);
});

test('dependencyResolver releases a waiting task when a run grant covers it', () => {
  const plan = {
    runId: 'run-1',
    workspace: 'test4',
    planRevision: 1,
    tasks: [task('ingest', {
      status: 'waiting_approval',
      requiresApproval: true,
      approvalClass: 'mutation',
    })],
  };

  assert.deepEqual(readyTasks(plan), []);
  assert.deepEqual(readyTasks(plan, {
    approvals: [{
      status: 'approved',
      scope: 'run',
      runId: 'run-1',
      workspaceId: 'test4',
      planRevision: 1,
      approvalClasses: ['mutation'],
    }],
  }).map((item) => item.id), ['ingest']);
});

test('dependencyResolver skips tasks whose locks are not free and keeps other ready work moving', () => {
  const lockManager = createLockManager();
  const held = lockManager.acquire(['deliverable:a.md']);
  const plan = [
    task('blocked', { locks: ['deliverable:a.md'], priority: 1 }),
    task('free', { locks: ['deliverable:b.md'], priority: 2 }),
  ];

  assert.deepEqual(readyTasks(plan, { lockManager }).map((item) => item.id), ['free']);
  held.release();
  assert.deepEqual(readyTasks(plan, { lockManager }).map((item) => item.id), ['blocked', 'free']);
});

test('budgetManager blocks ready tasks once the run budget is exceeded', () => {
  const budgetManager = createBudgetManager({ budgets: { maxTasks: 0 }, runId: 'run-budget' });

  assert.deepEqual(readyTasks([task('a')], { budgetManager }), []);
  assert.equal(budgetManager.exceeded().reason, 'max_tasks_exceeded');
});

test('budgetManager tracks attempts depth duration and tokens per run', () => {
  const budgetManager = createBudgetManager({
    budgets: { maxAttempts: 1, maxDepth: 2, maxDurationMs: 5, maxTokens: 10 },
    runId: 'run-budget-counters',
  });

  budgetManager.recordTaskStart(task('a', { depth: 2 }));
  assert.equal(budgetManager.canStartTask(task('b')), false);
  assert.equal(budgetManager.exceeded().reason, 'max_attempts_exceeded');
  assert.throws(
    () => budgetManager.recordTaskResult({ metrics: { durationMs: 6, totalTokens: 9 } }),
    /max_duration_exceeded/,
  );
  assert.equal(budgetManager.snapshot().durationMs, 6);
  assert.equal(budgetManager.snapshot().tokens, 9);
});

test('scheduler.effectiveConcurrency returns the minimum effective concurrency', () => {
  const group = { recommendedConcurrency: 4 };
  const agent = { description: { limits: { recommendedConcurrency: 3, maxConcurrency: 8 } } };
  const donna = { schedulerConcurrency: 6 };
  const provider = { capability: { limits: { maxConcurrency: 2 } }, maxConcurrency: 5 };

  assert.equal(effectiveConcurrency(group, agent, donna, provider), 2);
});

test('scheduler uses the relevant agent declaration instead of hard-capping plans at three', () => {
  const plan = [{ id: 'task-1', requiredCapability: 'ingest' }];
  const agents = [{
    description: {
      capabilities: [{ id: 'ingest' }],
      limits: { recommendedConcurrency: 10, maxConcurrency: 12 },
    },
  }];

  assert.equal(resolvePlanConcurrency({ plan, agents }), 10);
  assert.equal(resolvePlanConcurrency({ plan, agents, configured: 3 }), 3);
  assert.equal(resolvePlanConcurrency({ plan, agents, configured: 20 }), 10);
});

test('scheduler ignores unrelated agents and falls back to three without declarations', () => {
  const plan = [{ id: 'task-1', requiredCapability: 'ingest' }];
  const agents = [{
    description: {
      capabilities: [{ id: 'production' }],
      limits: { recommendedConcurrency: 1 },
    },
  }];

  assert.equal(resolvePlanConcurrency({ plan, agents }), 3);
});

test('capability constraints can lower but never raise an agent declaration', () => {
  const agent = { description: { limits: { recommendedConcurrency: 6, maxConcurrency: 10 } } };

  assert.equal(resolveCapabilityConcurrency(agent), 6);
  assert.equal(resolveCapabilityConcurrency(agent, 2), 2);
  assert.equal(resolveCapabilityConcurrency(agent, 20), 6);
});

test('startReadyTasks starts only ready tasks and respects lock starvation', () => {
  const active = new Map();
  const lockManager = createLockManager();
  const attemptManager = {
    reserve(item) {
      const reservation = lockManager.acquire(item);
      if (!reservation) return null;
      return { attemptId: `${item.id}:attempt-1`, release: reservation.release };
    },
  };
  const started = [];
  const count = startReadyTasks({
    plan: [
      task('blocked', { locks: ['workspace:write'], priority: 1 }),
      task('free', { locks: ['deliverable:a.md'], priority: 2 }),
    ],
    active,
    attemptManager,
    lockManager,
    limit: 2,
    startTask(item) {
      started.push(item.id);
      return { promise: Promise.resolve({ ok: true, taskId: item.id }) };
    },
  });

  assert.equal(count, 2);
  assert.deepEqual(started, ['blocked', 'free']);
  assert.deepEqual(lockManager.snapshot(), ['deliverable:a.md', 'workspace:write']);
});

test('orchestrator modules do not import business-specific packages', () => {
  const banned = /\b(?:production|cme|commercial|documents|wiki)\b/;
  const orchestratorDir = new URL('.', import.meta.url).pathname;
  const offenders = readdirSync(orchestratorDir)
    .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
    .flatMap((file) => {
      const content = readFileSync(join(orchestratorDir, file), 'utf8');
      return content
        .split('\n')
        .filter((line) => /^\s*import\s/.test(line) && banned.test(line))
        .map((line) => `${file}: ${line.trim()}`);
    });

  assert.deepEqual(offenders, []);
});

function task(id, overrides = {}) {
  return {
    id,
    step: overrides.step ?? 1,
    status: overrides.status ?? 'pending',
    dependsOn: overrides.dependsOn ?? [],
    requiredCapability: 'workspace.diagnose',
    operation: 'doctor',
    locks: [],
    requiresApproval: false,
    ...overrides,
  };
}
