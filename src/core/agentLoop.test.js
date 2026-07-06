import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';
import { runAgentTurn, runAgenticLoop } from './agentLoop.js';

test('runAgentTurn returns a one-line LLM error on empty stream', async () => {
  const session = {
    commands: [],
    llm: {
      async *stream() {},
    },
  };
  const agent = {
    async invoke() {
      return { readyToStream: true, streamContext: { messages: [] } };
    },
  };

  const response = await runAgentTurn(agent, session, 'salut');

  assert.equal(response, '⚠ LLM injoignable : flux vide');
});

test('runAgenticLoop waits for new activities and continues with a completion summary', async () => {
  const session = {
    activities: {},
    headlessPlan: null,
  };
  const inputs = [];
  const callbacks = [];
  const agent = {
    async invoke({ input, session: turnSession }) {
      inputs.push(input);
      if (inputs.length === 1) {
        dispatchAgentEvent(turnSession, createAgentEvent('activity_upserted', {
          payload: {
            activity: {
              id: 'job-1',
              source: 'production',
              kind: 'job',
              label: 'production job',
              status: 'running',
              terminal: false,
            },
          },
        }));
        return { response: 'Started production job.' };
      }
      return { response: 'All done.' };
    },
  };

  const result = await runAgenticLoop(agent, session, 'Build workspace', {
    maxTurns: 3,
    timeoutMs: 1000,
    waitForActivities: async (turnSession, startedActivities) => {
      assert.equal(startedActivities.length, 1);
      dispatchAgentEvent(turnSession, createAgentEvent('activity_upserted', {
        payload: {
          activity: {
            id: 'job-1',
            source: 'production',
            kind: 'job',
            label: 'production job',
            status: 'done',
            terminal: true,
          },
        },
      }));
      if (turnSession.headlessPlan?.[0]) turnSession.headlessPlan[0].status = 'done';
      return { ok: true, completed: Object.values(turnSession.activities) };
    },
    onActivitiesStarted: ({ activities }) => callbacks.push(`started:${activities.length}`),
    onActivitiesCompleted: ({ summary }) => callbacks.push(summary),
  });

  assert.equal(result.ok, true);
  assert.equal(inputs.length, 2);
  assert.match(inputs[1], /Completed activities:/);
  assert.match(inputs[1], /production job-1: done/);
  assert.deepEqual(callbacks, ['started:1', '- production job-1: done']);
});

test('runAgenticLoop extracts a fallback numbered plan from first response', async () => {
  const session = {
    activities: {},
    headlessPlan: null,
  };
  const result = await runAgenticLoop({
    async invoke() {
      return { response: '1. Collect sources\n2. Build page' };
    },
  }, session, 'Plan task', {
    maxTurns: 1,
    timeoutMs: 1000,
    waitForActivities: async () => assert.fail('No activities should be waited for.'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.maxTurns, true);
  assert.equal(session.headlessPlan.length, 2);
  assert.equal(session.headlessPlan[0].description, 'Collect sources');
});
