import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEvent, dispatchAgentEvent, reduceAgentEvents } from './agentEvents.js';

test('reduceAgentEvents: run_started clears stale plan', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:old',
          id: 'old',
          source: 'production',
          label: 'Old job',
          status: 'running',
        },
      },
    }),
    createAgentEvent('plan_set', {
      origin: 'tool',
      payload: { steps: ['Old action'] },
    }),
    createAgentEvent('run_started', { origin: 'user' }),
  ]);
  assert.equal(projection.plan.length, 3);
  assert.equal(projection.plan[0].description, 'Analyze the request');
  assert.equal(projection.plan[0].owner, 'orchestrator');
  assert.equal(projection.activities.length, 0);
  assert.equal(projection.status, 'running');
});

test('reduceAgentEvents: tracks manual plan and step updates', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', {
      origin: 'tool',
      payload: { steps: ['Export CME', 'Build deliverable'] },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'tool',
      payload: { step: 1, status: 'done' },
    }),
  ]);
  assert.equal(projection.plan.length, 2);
  assert.equal(projection.plan[0].status, 'done');
  assert.equal(projection.plan[1].status, 'pending');
});

test('reduceAgentEvents: activity with plan creates visible plan and progress', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:job-1',
          id: 'job-1',
          source: 'production',
          label: 'Pipeline',
          status: 'running',
          plan: { steps: [{ id: 'build', label: 'Build' }, { id: 'polish', label: 'Polish' }] },
          progress: { stepId: 'build' },
        },
      },
    }),
  ]);
  assert.equal(projection.activities.length, 1);
  assert.equal(projection.plan.length, 2);
  assert.equal(projection.plan[0].description, 'Build');
  assert.equal(projection.plan[0].status, 'running');
  assert.equal(projection.plan[1].status, 'pending');
});

test('reduceAgentEvents: activity attaches to orchestrator plan without replacing it', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('plan_set', {
      origin: 'tool',
      payload: { steps: [{ description: 'cme.cme_export_run', status: 'running', _activityKey: null }] },
    }),
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'cme:export-1',
          id: 'export-1',
          source: 'cme',
          label: 'CME export',
          status: 'running',
        },
      },
    }),
  ]);
  assert.equal(projection.plan.length, 1);
  assert.equal(projection.plan[0].description, 'cme.cme_export_run');
  assert.equal(projection.plan[0].owner, 'orchestrator');
  assert.equal(projection.plan[0].activityKey, 'cme:export-1');
  assert.equal(projection.plan[0].ownerActivityKey, 'cme:export-1');
});

test('reduceAgentEvents: run activity attaches to execution step of default plan', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('run_started', { origin: 'runtime' }),
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:build-1',
          id: 'build-1',
          source: 'production',
          label: 'Production build',
          status: 'running',
        },
      },
    }),
  ]);

  assert.equal(projection.plan[0].status, 'done');
  assert.equal(projection.plan[1].status, 'running');
  assert.equal(projection.plan[1].activityKey, 'production:build-1');
  assert.equal(projection.plan[2].status, 'pending');
});

test('reduceAgentEvents: run_done finalizes running and pending plan steps', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('run_started', { origin: 'runtime' }),
    createAgentEvent('run_done', { origin: 'runtime' }),
  ]);

  assert.deepEqual(projection.plan.map((step) => step.status), ['done', 'done', 'done']);
  assert.equal(projection.status, 'done');
});

test('dispatchAgentEvent: run_done finalizes session plan', () => {
  const session = {};
  dispatchAgentEvent(session, createAgentEvent('run_started', { origin: 'runtime' }));
  dispatchAgentEvent(session, createAgentEvent('run_done', { origin: 'runtime' }));

  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done', 'done']);
  assert.equal(session.agentProjection.status, 'done');
});

test('reduceAgentEvents: run_evaluated exposes evaluator verdict', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('run_started', { origin: 'runtime', runId: 'run-1' }),
    createAgentEvent('run_evaluated', {
      origin: 'runtime',
      runId: 'run-1',
      payload: {
        ok: false,
        reason: 'Missing export.',
        suggestedAction: 'Run export step.',
      },
    }),
  ]);

  assert.deepEqual(projection.evaluation, {
    ok: false,
    reason: 'Missing export.',
    suggestedAction: 'Run export step.',
    runId: 'run-1',
  });
  assert.equal(projection.status, 'running');
});

test('reduceAgentEvents: activity-owned plan is used when no orchestrator plan exists', () => {
  const projection = reduceAgentEvents([
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      payload: {
        activity: {
          key: 'production:job-1',
          id: 'job-1',
          source: 'production',
          label: 'Production build',
          status: 'running',
        },
      },
    }),
  ]);

  assert.equal(projection.plan.length, 1);
  assert.equal(projection.plan[0].description, 'Production build');
  assert.equal(projection.plan[0].owner, 'activity');
  assert.equal(projection.plan[0].ownerActivityKey, 'production:job-1');
});

test('dispatchAgentEvent: writes compatibility projections to session', () => {
  const session = {};
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'tool',
    payload: { steps: ['Check status'] },
  }));
  assert.equal(session.agentEvents.length, 1);
  assert.equal(session.headlessPlan.length, 1);
  assert.equal(session.headlessPlan[0].description, 'Check status');
  assert.deepEqual(session.activities, {});
});

test('dispatchAgentEvent: assistant deltas do not rewrite session plan or activities', () => {
  let planUpdates = 0;
  const session = { _onPlanUpdate: () => { planUpdates += 1; } };
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    origin: 'tool',
    payload: {
      activity: {
        key: 'cme:export-1',
        id: 'export-1',
        source: 'cme',
        label: 'CME export',
        status: 'running',
      },
    },
  }));
  const activitiesRef = session.activities;
  const planRef = session.headlessPlan;
  const updatesAfterActivity = planUpdates;

  dispatchAgentEvent(session, createAgentEvent('assistant_delta', {
    origin: 'llm',
    payload: { delta: 'bonjour' },
  }));

  assert.strictEqual(session.activities, activitiesRef);
  assert.strictEqual(session.headlessPlan, planRef);
  assert.equal(planUpdates, updatesAfterActivity);
  assert.equal(session.agentProjection.conversation.at(-1).content, 'bonjour');
});
