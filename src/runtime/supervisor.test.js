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

test('pollActivitiesOnce retries transient MCP poll failures', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => 'temporarily unavailable',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        result: {
          content: [{ type: 'text', text: JSON.stringify({
            _activity: {
              id: 'job-retry',
              source: 'production',
              status: 'done',
              terminal: true,
            },
          }) }],
        },
      }),
    };
  };

  const session = {
    mcp: {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        retry: { maxAttempts: 2, backoffMs: 0 },
      },
    },
    activities: {},
    headlessPlan: null,
    jobQueue: [],
  };
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    payload: {
      activity: {
        id: 'job-retry',
        source: 'production',
        status: 'running',
        poll: { server: 'production', tool: 'production_job_status', args: { jobId: 'job-retry' }, intervalMs: 0 },
      },
    },
  }));

  try {
    await pollActivitiesOnce(session);
    const key = Object.keys(session.activities)[0];
    assert.equal(attempts, 2);
    assert.equal(session.activities[key].status, 'done');
  } finally {
    globalThis.fetch = originalFetch;
  }
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
