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
    assert.equal(runCount, 1);
  } finally {
    releaseRun?.();
    await handle.close();
  }
});
