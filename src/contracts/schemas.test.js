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
