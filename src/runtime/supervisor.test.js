import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { discoverAgentsOnce, pollActivitiesOnce, startActivitySupervisor } from './supervisor.js';

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

test('startActivitySupervisor periodically re-scans the agent registry', async () => {
  const session = {
    mcp: {},
    activities: {},
    headlessPlan: null,
    jobQueue: [],
  };
  let discoveries = 0;
  const registry = {
    async discover() {
      discoveries += 1;
      return [];
    },
    snapshot() {
      return [];
    },
  };

  const supervisor = startActivitySupervisor(session, {
    intervalMs: 1000,
    queueIntervalMs: 1000,
    agentRegistryIntervalMs: 10,
    agentRegistry: registry,
  });

  try {
    await waitFor(() => discoveries >= 2);
    assert.equal(session.agentRegistry, registry);
  } finally {
    supervisor.stop();
  }
});

test('discoverAgentsOnce uses the session registry and returns discovered agents', async () => {
  const expected = [{ agentInstanceId: 'a' }];
  const registry = {
    async discover(session) {
      assert.equal(session.workspace, 'docs');
      return expected;
    },
  };
  const session = { workspace: 'docs', agentRegistry: registry };

  assert.equal(await discoverAgentsOnce(session), expected);
});

test('pollActivitiesOnce fires _onActivitiesTerminal when last activity becomes terminal', async () => {
  let fired = false;
  const session = {
    mcp: { production: { status: 'connected' } },
    activities: {},
    headlessPlan: null,
    jobQueue: [],
    _onActivitiesTerminal: () => { fired = true; },
  };
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    payload: {
      activity: {
        id: 'job-hook',
        source: 'production',
        status: 'running',
        poll: { server: 'production', tool: 'production_job_status', args: { jobId: 'job-hook' }, intervalMs: 0 },
      },
    },
  }));
  const key = Object.keys(session.activities)[0];
  session.activities[key].lastPolledAt = '1970-01-01T00:00:00.000Z';

  await pollActivitiesOnce(session, {
    callTool: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        _activity: { id: 'job-hook', source: 'production', status: 'done', terminal: true },
      }) }],
    }),
  });

  assert.equal(fired, true);
  assert.equal(session._onActivitiesTerminal, undefined);
});

test('pollActivitiesOnce does not fire _onActivitiesTerminal while other activities remain', async () => {
  let fired = false;
  const session = {
    mcp: { production: { status: 'connected' } },
    activities: {},
    headlessPlan: null,
    jobQueue: [],
    _onActivitiesTerminal: () => { fired = true; },
  };
  for (const id of ['job-a', 'job-b']) {
    dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
      payload: {
        activity: {
          id,
          source: 'production',
          status: 'running',
          poll: { server: 'production', tool: 'production_job_status', args: { jobId: id }, intervalMs: 0 },
        },
      },
    }));
  }
  for (const key of Object.keys(session.activities)) {
    session.activities[key].lastPolledAt = '1970-01-01T00:00:00.000Z';
  }

  let callCount = 0;
  await pollActivitiesOnce(session, {
    callTool: async (_mcp, _server, _tool, args) => {
      callCount += 1;
      const terminal = args.jobId === 'job-a';
      return {
        content: [{ type: 'text', text: JSON.stringify({
          _activity: { id: args.jobId, source: 'production', status: terminal ? 'done' : 'running', terminal },
        }) }],
      };
    },
  });

  assert.equal(fired, false);
  assert.equal(callCount, 2);
});

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for condition.');
}

test('readNewTraceLines streams significant trace events with a per-activity cursor', async () => {
  const { readNewTraceLines } = await import('./supervisor.js');
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const workspacePath = mkdtempSync(join(tmpdir(), 'trace-tail-'));
  try {
    const rel = '.wiki/logs/ingest-test.log';
    const abs = join(workspacePath, rel);
    (await import('node:fs')).mkdirSync(join(workspacePath, '.wiki/logs'), { recursive: true });
    writeFileSync(abs, '2026-07-10T13:00:00.000Z +10ms INFO llm:start label=ingest_plan promptChars=42000\n');
    const session = { workspacePath };

    const first = readNewTraceLines(session, 'k1', rel);
    assert.deepEqual(first, ['llm:start label=ingest_plan promptChars=42000']);

    // No new content → nothing re-emitted.
    assert.deepEqual(readNewTraceLines(session, 'k1', rel), []);

    appendFileSync(abs, '2026-07-10T13:01:00.000Z +70s INFO noise: irrelevant heartbeat\n2026-07-10T13:02:00.000Z +130s WARN embedding:neutralized-input status=413\n');
    const second = readNewTraceLines(session, 'k1', rel);
    assert.deepEqual(second, ['WARN embedding:neutralized-input status=413']);

    // Path traversal attempts are refused.
    assert.deepEqual(readNewTraceLines(session, 'k1', '../../etc/passwd'), []);
    assert.deepEqual(readNewTraceLines(session, 'k1', '/etc/passwd'), []);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
