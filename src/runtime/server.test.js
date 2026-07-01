import assert from 'node:assert/strict';
import test from 'node:test';
import { startRuntimeServer } from './server.js';

test('runtime server accepts only one active run', async (t) => {
  let releaseRun;
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle' }),
        listEvents: () => [],
      },
      session: {},
      run: async () => {
        runCount += 1;
        await new Promise((resolve) => { releaseRun = resolve; });
      },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const url = `http://127.0.0.1:${handle.port}/run`;
    let acceptedRun = null;
    const [first, second] = await Promise.all([
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'first' }),
      }),
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'second' }),
      }),
    ]);

    assert.deepEqual([first.status, second.status].sort(), [202, 409]);
    const accepted = first.status === 202 ? first : second;
    acceptedRun = await accepted.json();
    assert.equal(acceptedRun.accepted, true);
    assert.match(acceptedRun.runId, /^[0-9a-f-]{36}$/);
    assert.equal(runCount, 1);
  } finally {
    releaseRun?.();
    await handle.close();
  }
});

test('runtime server returns the accepted run id and passes it to the runner', async (t) => {
  let receivedBody = null;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle' }),
        listEvents: () => [],
      },
      session: {},
      run: async (body) => {
        receivedBody = body;
      },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'build', workspace: 'juno' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.match(body.runId, /^[0-9a-f-]{36}$/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receivedBody.runId, body.runId);
    assert.equal(receivedBody.workspace, 'juno');
  } finally {
    await handle.close();
  }
});
