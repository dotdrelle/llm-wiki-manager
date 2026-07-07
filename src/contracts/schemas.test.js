import assert from 'node:assert/strict';
import test from 'node:test';
import { assertContract, validateContract } from './schemas.js';

test('activity contract accepts the canonical v1 shape and extra fields', () => {
  const activity = {
    schemaVersion: '1',
    id: 'job-1',
    source: 'production',
    kind: 'build',
    label: 'Production build',
    status: 'running',
    progress: {
      percent: 42,
      stepId: 'draft',
      parentActivityKey: 'production:parent',
      detail: 'Drafting',
    },
    poll: null,
    outputRefs: ['deliverables/report.md', { type: 'wiki_page', ref: 'Reports/Build' }],
    agentSpecificField: true,
  };

  assert.equal(validateContract('activity', activity).ok, true);
  assert.equal(assertContract('activity', activity), activity);
});

test('activity contract rejects missing canonical fields', () => {
  const result = validateContract('activity', {
    id: 'job-1',
    source: 'production',
    kind: 'build',
    label: 'Production build',
    status: 'running',
    progress: {},
    poll: null,
    outputRefs: [],
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('schemaVersion')));
});

test('agent event contract carries the unified audit identity fields', () => {
  const event = {
    id: 'event-1',
    ts: new Date(0).toISOString(),
    type: 'tool_call_result',
    origin: 'runtime',
    runId: 'run-1',
    turnId: 'turn-1',
    taskId: 'task-1',
    workspace: 'juno',
    payload: { toolCallId: 'call-1', ok: true },
  };

  assert.equal(validateContract('agentRunEvent', event).ok, true);
});

test('run and control request contracts reject empty run input but accept explicit controls', () => {
  assert.equal(validateContract('runRequest', { input: 'Build docs', workspace: 'juno' }).ok, true);
  assert.equal(validateContract('runRequest', { input: '' }).ok, false);
  assert.equal(validateContract('controlMessage', { action: 'message', input: 'Ou en est le build ?', intent: 'observe' }).ok, true);
});

test('plan and patch contracts cover structured dependencies and output refs', () => {
  const plan = [{
    step: 1,
    id: 'task-a',
    description: 'Export',
    status: 'pending',
    dependsOn: [],
    executor: 'cme.cme_export_run',
    executorQuery: null,
    outputRefs: ['raw/export.json'],
  }];
  const patch = {
    targetRunId: 'run-1',
    basePlanRevision: 4,
    operations: [{
      op: 'add_task',
      task: {
        id: 'task-b',
        description: 'Build',
        dependsOn: ['task-a'],
        executorQuery: { capability: 'production build' },
      },
    }],
  };

  assert.equal(validateContract('plan', plan).ok, true);
  assert.equal(validateContract('planPatch', patch).ok, true);
});

test('task graph fragment contract carries planned tasks and groups round-trip', () => {
  const fragment = {
    contractVersion: '1',
    agentInstanceId: 'production-main',
    capability: 'knowledge.update',
    summary: {
      label: 'Update knowledge',
      initialSynthesis: ['Two files will be ingested.'],
      estimatedTasks: 1,
    },
    groups: [{
      id: 'ingest',
      label: 'Ingest sources',
      recommendedConcurrency: 2,
      progressWeight: 2,
    }],
    tasks: [{
      id: 'ingest-a',
      label: 'Ingest source A',
      requiredCapability: 'knowledge.update',
      operation: 'ingest',
      arguments: { files: ['raw/untracked/a.md'] },
      groupId: 'ingest',
      dependsOn: [],
      parallelizable: true,
      recommendedConcurrency: 2,
      inputRefs: [{ type: 'file', ref: 'raw/untracked/a.md', label: 'A' }],
      expectedOutputRefs: ['wiki/a.md'],
      locks: ['workspace:wiki'],
      requiresApproval: false,
      idempotencyKey: null,
      progressWeight: 1,
      priority: 10,
      retryPolicy: {
        maxAttempts: 2,
        retryableErrors: ['timeout'],
        allowAgentFallback: false,
      },
    }],
    expectedOutputs: ['wiki/a.md'],
  };

  const roundTrip = JSON.parse(JSON.stringify(fragment));
  assert.deepEqual(roundTrip, fragment);
  assert.equal(validateContract('taskGraphFragment', roundTrip).ok, true);
  assert.equal(validateContract('plannedTask', roundTrip.tasks[0]).ok, true);
  assert.equal(validateContract('taskGroup', roundTrip.groups[0]).ok, true);
  assert.equal(validateContract('retryPolicy', roundTrip.tasks[0].retryPolicy).ok, true);
});

test('strict planned task contract rejects invalid fields and types', () => {
  const invalid = {
    id: 'bad',
    label: 'Bad task',
    requiredCapability: 'knowledge.update',
    operation: 'ingest',
    dependsOn: [],
    parallelizable: false,
    inputRefs: [],
    locks: [],
    requiresApproval: false,
    idempotencyKey: null,
    progressWeight: 1,
    executor: 'legacy-tool',
  };

  const result = validateContract('plannedTask', invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('executor is not allowed')));
  assert.throws(() => assertContract('plannedTask', invalid), /executor is not allowed/);
});

test('plan and plan patch contracts accept new planned task fields without rejecting legacy tasks', () => {
  const plannedTask = {
    id: 'publish',
    label: 'Publish deliverable',
    requiredCapability: 'document.publish',
    operation: 'publish',
    arguments: { target: 'deliverables/report.md' },
    dependsOn: ['build'],
    parallelizable: false,
    inputRefs: ['deliverables/report.md'],
    locks: ['deliverable:report.md'],
    requiresApproval: true,
    approvalClass: 'mutation',
    approvalSummary: 'Publish report',
    idempotencyKey: 'idem-1',
    progressWeight: 1,
  };
  const legacyTask = {
    step: 1,
    id: 'build',
    description: 'Build report',
    status: 'done',
    dependsOn: [],
    outputRefs: ['deliverables/report.md'],
  };

  assert.equal(validateContract('plan', [legacyTask, plannedTask]).ok, true);
  assert.equal(validateContract('planPatch', {
    basePlanRevision: 1,
    operations: [{ op: 'add_task', task: plannedTask }],
  }).ok, true);
});
