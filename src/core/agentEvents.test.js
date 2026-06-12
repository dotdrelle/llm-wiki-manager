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
  assert.equal(projection.plan, null);
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

test('reduceAgentEvents: real activity replaces minimal MCP plan', () => {
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
  assert.equal(projection.plan[0].description, 'CME export');
  assert.equal(projection.plan[0]._activityKey, 'cme:export-1');
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
