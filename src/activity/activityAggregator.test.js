import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateActivity } from './activityAggregator.js';
import { visibleActivityEvents } from './activityDeduplicator.js';
import { calculateWeightedProgress } from './progressCalculator.js';

test('activityDeduplicator keeps one visible entry for repeated 2 percent polls', () => {
  const events = Array.from({ length: 50 }, () => ({
    type: 'activity_upserted',
    payload: {
      activity: {
        id: 'ingest',
        label: 'ingest',
        status: 'running',
        progress: { percent: 2, phase: 'ingest' },
      },
    },
  }));

  assert.equal(visibleActivityEvents(events).length, 1);
});

test('calculateWeightedProgress includes active task partial progress', () => {
  const progress = calculateWeightedProgress([
    { id: 'collect', status: 'done', progressWeight: 2 },
    { id: 'build', status: 'running', progressWeight: 3, activityKey: 'activity-build' },
  ], [
    { key: 'activity-build', progress: { percent: 50 } },
  ]);

  assert.equal(progress.mode, 'weighted_tasks');
  assert.equal(progress.percent, 70);
});

test('aggregateActivity exposes initial synthesis and grouped display lines', () => {
  const activity = aggregateActivity({
    plan: [
      { id: 'collect', label: 'Collecte externe', groupId: 'collect', status: 'done', progressWeight: 1 },
      { id: 'enrich', label: 'Enrichissement commercial', groupId: 'enrich', requiredCapability: 'customer-data.enrich', operation: 'export', status: 'running', progressWeight: 1, activityKey: 'activity-enrich' },
      { id: 'publish', label: 'Publication', groupId: 'publish', status: 'pending', progressWeight: 1 },
    ],
    activities: [{ key: 'activity-enrich', label: 'Enrichissement commercial', status: 'running', progress: { percent: 63, stepId: 'enrich', label: 'Export rapport.md', detail: 'Rendering PDF', currentStep: 'export' } }],
  }, [{
    type: 'plan.received',
    payload: {
      fragment: {
        summary: {
          initialSynthesis: ['120 sources detectees', '6 traitements simultanes recommandes'],
        },
      },
    },
  }]);

  assert.deepEqual(activity.initialSynthesis, ['120 sources detectees', '6 traitements simultanes recommandes']);
  assert.equal(activity.progress.percent, 54);
  assert.ok(activity.lines.some((line) => /\[x\] collect - done/.test(line.label)));
  assert.ok(activity.lines.some((line) => /\[\.\.\.\] customer-data\.enrich - 63 %/.test(line.label)));
  const enrichLine = activity.lines.find((line) => /customer-data\.enrich/.test(line.label));
  assert.equal(enrichLine.progress.label, 'Export rapport.md');
  assert.equal(enrichLine.progress.detail, 'Rendering PDF');
  assert.equal(enrichLine.progress.currentStep, 'export');
  assert.equal(enrichLine.progress.taskIndex, 1);
  assert.equal(enrichLine.progress.taskTotal, 1);
  assert.equal(enrichLine.progress.taskOperation, 'export');
  assert.ok(activity.lines.some((line) => /\[ \] publish - en attente/.test(line.label)));
});

test('aggregateActivity keeps activities not attached to any plan task visible', () => {
  // Regression: a done one-step minimal plan (production_status) masked the
  // actually-running ingest activity started outside the plan.
  const state = {
    plan: [{
      id: 'status-check',
      step: 1,
      description: 'production.production_status',
      status: 'done',
      groupId: '1',
    }],
    activities: [
      {
        key: 'production:prod_192444',
        id: 'prod_192444',
        label: 'Ingest b87acaf6-Comite.md',
        source: 'production',
        status: 'running',
        terminal: false,
        progress: { percent: 15, detail: 'LLM running' },
      },
    ],
  };

  const aggregated = aggregateActivity(state, []);
  const labels = aggregated.lines.map((line) => line.label).join('\n');
  assert.match(labels, /\[x\] .* done/, 'the done plan group stays visible');
  assert.match(labels, /Ingest b87acaf6/, 'the unattached running ingest must appear');
  const ingestLine = aggregated.lines.find((line) => /Ingest/.test(line.label));
  assert.equal(ingestLine.status, 'running');
});

test('aggregateActivity trusts live worker progress while the task projection lags', () => {
  const aggregated = aggregateActivity({
    plan: [
      { id: 'plan-a', groupId: 'knowledge.update', operation: 'ingest_plan', status: 'pending_approval', activityKey: 'activity-plan-a' },
      { id: 'plan-b', groupId: 'knowledge.update', operation: 'ingest_plan', status: 'pending' },
    ],
    activities: [{
      key: 'activity-plan-a',
      status: 'running',
      terminal: false,
      progress: { percent: 35, stepId: 'plan-a', label: 'Ingest source-a.md', stepIndex: 1, stepTotal: 1 },
    }],
  }, []);

  const line = aggregated.lines.find((item) => /knowledge\.update/.test(item.label));
  assert.match(line.label, /35 %/);
  assert.equal(line.progress.percent, 35);
  assert.equal(line.progress.label, 'Ingest source-a.md');
  assert.equal(line.progress.taskIndex, 1);
  assert.equal(line.progress.taskTotal, 2);
});

test('aggregateActivity keeps a healthy active task out of the error color when a sibling failed', () => {
  const aggregated = aggregateActivity({
    plan: [
      { id: 'failed-a', groupId: 'ingest', operation: 'ingest_plan', status: 'failed' },
      { id: 'running-b', groupId: 'ingest', operation: 'ingest_plan', status: 'running', activityKey: 'activity-b' },
    ],
    activities: [{
      key: 'activity-b',
      status: 'running',
      terminal: false,
      progress: { percent: 35, stepId: 'running-b', label: 'Ingest application-orea.md', detail: 'LLM running' },
    }],
  }, []);

  const line = aggregated.lines[0];
  assert.equal(line.status, '35 %');
  assert.match(line.label, /^\[\.\.\.\]/);
  assert.equal(line.progress.label, 'Ingest application-orea.md');
});
