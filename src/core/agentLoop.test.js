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
  assert.match(inputs[1], /- job: done/);
  assert.deepEqual(callbacks, ['started:1', '- job: done']);
});

test('runAgenticLoop can finish from terminal activity facts without another LLM turn', async () => {
  const session = { activities: {}, headlessPlan: null };
  let turns = 0;
  const result = await runAgenticLoop({
    async invoke({ session: turnSession }) {
      turns += 1;
      dispatchAgentEvent(turnSession, createAgentEvent('activity_upserted', {
        payload: {
          activity: {
            id: 'job-build',
            source: 'production',
            kind: 'build',
            label: 'Build workspace',
            status: 'running',
            terminal: false,
          },
        },
      }));
      return { response: 'Job started.' };
    },
  }, session, 'Build workspace', {
    maxTurns: 3,
    timeoutMs: 1000,
    deterministicTerminalSummary: true,
    waitForActivities: async (turnSession) => {
      dispatchAgentEvent(turnSession, createAgentEvent('activity_upserted', {
        payload: {
          activity: {
            id: 'job-build',
            source: 'production',
            kind: 'build',
            label: 'Build workspace',
            status: 'done',
            terminal: true,
            outputRefs: ['deliverables/result.md'],
          },
        },
      }));
      return { ok: true, completed: Object.values(turnSession.activities) };
    },
  });

  assert.equal(turns, 1);
  assert.equal(result.deterministicSummary, true);
  assert.match(result.summary, /build: done/);
  assert.match(result.summary, /output: deliverables\/result\.md/);
});

test('runAgenticLoop never turns a chatty numbered answer into a plan', async () => {
  // Regression guard for the removed text-plan extraction: the model's own
  // numbered prose ("1. … 2. … Souhaitez-vous… ?") used to become pending
  // tasks and re-invoke the LLM in an infinite work-inventing loop. A chatty
  // answer with no declared plan and no activity is simply a COMPLETE reply.
  const session = {
    activities: {},
    headlessPlan: null,
  };
  const result = await runAgenticLoop({
    async invoke() {
      return { response: '1. Collect sources\n2. Build page\nSouhaitez-vous que je vous guide ?' };
    },
  }, session, 'Plan task', {
    maxTurns: 3,
    timeoutMs: 1000,
    waitForActivities: async () => assert.fail('No activities should be waited for.'),
  });

  assert.equal(result.ok, true, 'the run completes with the reply instead of inventing steps');
  assert.equal(session.headlessPlan, null);
});
