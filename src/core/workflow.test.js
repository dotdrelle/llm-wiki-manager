import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkflow } from './workflow.js';

test('projectWorkflow links structured plan tasks to activities and executors', () => {
  const workflow = projectWorkflow({
    status: 'running',
    runId: 'run-1',
    workspace: 'docs',
    plan: [
      { step: 1, id: 'export', description: 'Export CME', status: 'done', executor: 'cme.cme_export_run', outputRefs: ['raw/untracked'] },
      { step: 2, id: 'build', description: 'Build deliverable', status: 'running', dependsOn: ['export'], executor: 'production.production_start_job', activityKey: 'production:job-1' },
    ],
    activities: [{
      key: 'production:job-1',
      id: 'job-1',
      source: 'production',
      label: 'Production build',
      status: 'running',
      progress: { percent: 42, stepId: 'build' },
    }],
    queue: [],
    approvals: [],
  });

  assert.equal(workflow.summary.status, 'running');
  assert.equal(workflow.current.id, 'task:build');
  assert.equal(workflow.next, null);
  assert.equal(workflow.progress.mode, 'activity_percent');
  assert.equal(workflow.progress.percent, 42);
  assert.ok(workflow.relations.some((relation) => relation.type === 'depends_on' && relation.from === 'task:build' && relation.to === 'task:export'));
  assert.ok(workflow.relations.some((relation) => relation.type === 'executed_by' && relation.from === 'task:build' && relation.to === 'activity:production:job-1'));
  assert.ok(workflow.relations.some((relation) => relation.type === 'produces' && relation.from === 'task:export' && relation.to === 'output:raw/untracked'));
});

test('projectWorkflow keeps old sequential runs readable', () => {
  const workflow = projectWorkflow({
    status: 'done',
    plan: [
      { step: 1, description: 'Analyze', status: 'done' },
      { step: 2, description: 'Execute', status: 'done' },
    ],
    activities: [],
    queue: [],
    approvals: [],
  });

  assert.equal(workflow.summary.status, 'done');
  assert.equal(workflow.progress.mode, 'task_count');
  assert.equal(workflow.progress.percent, 100);
  assert.deepEqual(workflow.warnings, ['legacy_sequential_plan']);
});

test('projectWorkflow reports approval and queue waiting reasons', () => {
  const workflow = projectWorkflow({
    status: 'running',
    plan: [{ step: 1, id: 'send', description: 'Send email', status: 'pending_approval' }],
    activities: [],
    queue: [{ id: 'queued-1', status: 'queued', label: 'Future run' }],
    approvals: [{ id: 'approval-1', status: 'pending_approval', reason: 'Confirm email' }],
  });

  assert.equal(workflow.current.id, 'task:send');
  assert.ok(workflow.waitingReasons.includes('approval:approval-1'));
  assert.ok(workflow.waitingReasons.includes('queue:queued-1'));
});

test('projectWorkflow aggregates input and output tokens once per attempt', () => {
  const state = {
    status: 'done',
    runId: 'run-usage',
    plan: [{ id: 'build', description: 'Build', status: 'done' }],
    activities: [],
    queue: [],
    approvals: [],
  };
  const result = {
    attemptId: 'attempt-1',
    metrics: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
  };
  const workflow = projectWorkflow(state, [
    { id: 'event-1', type: 'task.result_returned', runId: 'run-usage', taskId: 'build', payload: { result } },
    { id: 'event-2', type: 'task.completed', runId: 'run-usage', taskId: 'build', payload: { result } },
  ]);

  assert.deepEqual(workflow.usage, {
    inputTokens: 1200,
    outputTokens: 300,
    totalTokens: 1500,
    inputKnown: true,
    outputKnown: true,
    totalKnown: true,
    byTask: {
      build: {
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        inputKnown: true,
        outputKnown: true,
        totalKnown: true,
      },
    },
  });
});

test('projectWorkflow derives per-task timing (start, finish, duration) from lifecycle events', () => {
  const state = {
    status: 'done',
    runId: 'run-timing',
    plan: [{ id: 'ingest', description: 'Ingest', status: 'done' }],
    activities: [],
    queue: [],
    approvals: [],
  };
  const workflow = projectWorkflow(state, [
    { id: 'e1', type: 'task.started', runId: 'run-timing', taskId: 'ingest', ts: '2026-07-23T10:00:00.000Z', payload: {} },
    { id: 'e2', type: 'task.completed', runId: 'run-timing', taskId: 'ingest', ts: '2026-07-23T10:00:12.500Z', payload: {} },
  ]);

  assert.equal(workflow.timingByTask.ingest.startedAt, Date.parse('2026-07-23T10:00:00.000Z'));
  assert.equal(workflow.timingByTask.ingest.finishedAt, Date.parse('2026-07-23T10:00:12.500Z'));
  assert.equal(workflow.timingByTask.ingest.durationMs, 12500);
});
