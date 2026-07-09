import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActivity, extractActivity, isCancelledStatus, rememberActivity, rememberActivityFromPayload } from './activity.js';

test('normalizeActivity: plan.steps preserved with id and label', () => {
  const a = normalizeActivity({
    id: 'job-1',
    source: 'prod',
    label: 'Test',
    status: 'running',
    plan: { steps: [{ id: 'extract', label: 'Extraction' }, { id: 'build', label: 'Build' }] },
    progress: {},
  });
  assert.equal(a.schemaVersion, '1');
  assert.deepEqual(a.outputRefs, []);
  assert.deepEqual(a.plan.steps, [
    { id: 'extract', label: 'Extraction', dependsOn: [], executor: null, executorQuery: null, outputRefs: [] },
    { id: 'build', label: 'Build', dependsOn: [], executor: null, executorQuery: null, outputRefs: [] },
  ]);
});

test('normalizeActivity: plan null when steps is empty array', () => {
  const a = normalizeActivity({ id: '1', status: 'running', plan: { steps: [] } });
  assert.equal(a.plan, null);
});

test('normalizeActivity: plan null when no plan field', () => {
  const a = normalizeActivity({ id: '1', status: 'running' });
  assert.equal(a.plan, null);
});

test('isCancelledStatus recognizes both cancellation spellings', () => {
  assert.equal(isCancelledStatus('cancelled'), true);
  assert.equal(isCancelledStatus('canceled'), true);
  assert.equal(isCancelledStatus('CANCELLED'), true);
  assert.equal(isCancelledStatus('failed'), false);
  assert.equal(isCancelledStatus(null), false);
});

test('normalizeActivity: step id falls back to 1-based index when missing', () => {
  const a = normalizeActivity({
    id: '1',
    status: 'running',
    plan: { steps: [{ label: 'Step A' }, { label: 'Step B' }] },
  });
  assert.equal(a.plan.steps[0].id, '1');
  assert.equal(a.plan.steps[0].label, 'Step A');
  assert.equal(a.plan.steps[1].id, '2');
});

test('normalizeActivity: stepId/stepIndex/stepTotal normalized from progress', () => {
  const a = normalizeActivity({
    id: '1',
    status: 'running',
    progress: { stepId: 'build', stepIndex: 2, stepTotal: 3 },
  });
  assert.equal(a.progress.stepId, 'build');
  assert.equal(a.progress.stepIndex, 2);
  assert.equal(a.progress.stepTotal, 3);
});

test('normalizeActivity: stepId/stepIndex absent when not provided', () => {
  const a = normalizeActivity({ id: '1', status: 'running', progress: {} });
  assert.equal(a.progress.stepId, undefined);
  assert.equal(a.progress.stepIndex, undefined);
});

test('extractActivity: extracts _activity.plan.steps from payload', () => {
  const payload = {
    _activity: {
      id: 'j1',
      source: 'custom',
      label: 'Custom job',
      status: 'running',
      plan: { steps: [{ id: 's1', label: 'Step 1' }] },
      progress: { stepId: 's1', stepIndex: 1, stepTotal: 1 },
    },
  };
  const a = extractActivity(payload);
  assert.equal(a.plan.steps[0].id, 's1');
  assert.equal(a.progress.stepId, 's1');
  assert.equal(a.progress.stepIndex, 1);
  assert.equal(a.progress.stepTotal, 1);
});

test('extractActivity: documents conversion activity carries plan and percent', () => {
  const payload = {
    _activity: {
      id: 'documents:schema.png',
      source: 'documents',
      kind: 'conversion',
      label: 'Documents: conversion schema.png',
      status: 'done',
      progress: { percent: 100, stepId: 'write', stepIndex: 3, stepTotal: 3 },
      plan: {
        steps: [
          { id: 'resolve', label: 'Résoudre le fichier source' },
          { id: 'convert', label: 'Convertir en Markdown' },
          { id: 'write', label: 'Écrire le Markdown converti' },
        ],
      },
      terminal: true,
    },
  };
  const activity = extractActivity(payload, { server: 'documents' });
  assert.equal(activity.source, 'documents');
  assert.equal(activity.progress.percent, 100);
  assert.equal(activity.terminal, true);
  assert.deepEqual(activity.plan.steps.map((step) => step.id), ['resolve', 'convert', 'write']);
});

test('rememberActivity: returns normalized activity on success', () => {
  const session = {};
  const result = rememberActivity(session, { id: '1', status: 'running', source: 'x', kind: 'job' });
  assert.ok(result);
  assert.equal(typeof result, 'object');
  assert.equal(result.status, 'running');
});

test('rememberActivity: returns null for invalid input', () => {
  const session = {};
  assert.equal(rememberActivity(session, null), null);
  assert.equal(rememberActivity(session, 'bad'), null);
});

test('rememberActivityFromPayload: returns activity for _activity payload', () => {
  const session = {};
  const payload = { _activity: { id: '1', source: 'x', status: 'running' } };
  const result = rememberActivityFromPayload(session, payload);
  assert.ok(result);
  assert.equal(result.source, 'x');
});

test('rememberActivityFromPayload: returns null for irrelevant payload', () => {
  const session = {};
  assert.equal(rememberActivityFromPayload(session, { message: 'ok' }), null);
});
