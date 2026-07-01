import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { pollActivitiesOnce, startActivitySupervisor } from './supervisor.js';

test('pollActivitiesOnce updates activity through the event reducer', async () => {
  const session = {
    mcp: { production: { status: 'connected' } },
    activities: {},
    headlessPlan: null,
    jobQueue: [],
  };
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    payload: {
      activity: {
        id: 'job-1',
        source: 'production',
        status: 'running',
        poll: { server: 'production', tool: 'production_job_status', args: { jobId: 'job-1' }, intervalMs: 1000 },
      },
    },
  }));
  const key = Object.keys(session.activities)[0];
  session.activities[key].lastPolledAt = '1970-01-01T00:00:00.000Z';

  await pollActivitiesOnce(session, {
    callTool: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        _activity: {
          id: 'job-1',
          source: 'production',
          status: 'done',
          terminal: true,
        },
      }) }],
    }),
  });

  assert.equal(session.activities[key].status, 'done');
  assert.equal(session.activities[key].terminal, true);
  assert.ok(session.agentProjection.logs.some((line) => line.includes('activity:')));
});

test('startActivitySupervisor passes the active run signal to background polls', async () => {
  const session = {
    mcp: { production: { status: 'connected' } },
    activities: {},
    headlessPlan: null,
    jobQueue: [],
  };
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    payload: {
      activity: {
        id: 'job-2',
        source: 'production',
        status: 'running',
        poll: { server: 'production', tool: 'production_job_status', args: { jobId: 'job-2' }, intervalMs: 0 },
      },
    },
  }));

  const controller = new AbortController();
  const signals = [];
  const supervisor = startActivitySupervisor(session, {
    intervalMs: 10,
    queueIntervalMs: 1000,
    callTool: async (_mcp, _server, _tool, _args, signal) => {
      signals.push(signal ?? null);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          _activity: {
            id: 'job-2',
            source: 'production',
            status: 'running',
            terminal: false,
            poll: { server: 'production', tool: 'production_job_status', args: { jobId: 'job-2' }, intervalMs: 0 },
          },
        }) }],
      };
    },
  });

  try {
    supervisor.setRunSignal(controller.signal);
    await waitFor(() => signals.includes(controller.signal));
    assert.ok(signals.includes(controller.signal));
  } finally {
    supervisor.stop();
  }
});

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for condition.');
}
