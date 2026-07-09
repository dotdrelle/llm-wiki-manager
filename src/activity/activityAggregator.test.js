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
      { id: 'enrich', label: 'Enrichissement commercial', groupId: 'enrich', requiredCapability: 'customer-data.enrich', status: 'running', progressWeight: 1, activityKey: 'activity-enrich' },
      { id: 'publish', label: 'Publication', groupId: 'publish', status: 'pending', progressWeight: 1 },
    ],
    activities: [{ key: 'activity-enrich', label: 'Enrichissement commercial', status: 'running', progress: { percent: 63, stepId: 'enrich' } }],
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
