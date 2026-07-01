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
      run: async (context, body) => {
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
      body: JSON.stringify({ input: 'build', workspace: 'juno', evaluate: false, replans: 1 }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.match(body.runId, /^[0-9a-f-]{36}$/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receivedBody.runId, body.runId);
    assert.equal(receivedBody.workspace, 'juno');
    assert.equal(receivedBody.evaluate, false);
    assert.equal(receivedBody.replans, 1);
  } finally {
    await handle.close();
  }
});

test('runtime server isolates active runs by workspace', async (t) => {
  const releases = new Map();
  const runWorkspaces = [];
  const contexts = new Map();
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: (session) => ({ status: session?.running ? 'running' : 'idle' }),
        listEvents: () => [],
      },
      getContext: async (workspace) => {
        if (!contexts.has(workspace)) {
          contexts.set(workspace, {
            workspace,
            session: { workspace },
            running: false,
            currentAbortController: null,
          });
        }
        return contexts.get(workspace);
      },
      run: async (context) => {
        runWorkspaces.push(context.workspace);
        context.session.running = true;
        await new Promise((resolve) => { releases.set(context.workspace, resolve); });
        context.session.running = false;
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
    const [juno, docs] = await Promise.all([
      fetch(`${url}?workspace=juno`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'first' }),
      }),
      fetch(`${url}?workspace=docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'second' }),
      }),
    ]);
    assert.deepEqual([juno.status, docs.status], [202, 202]);

    const conflict = await fetch(`${url}?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'third' }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(runWorkspaces.sort(), ['docs', 'juno']);
  } finally {
    releases.get('juno')?.();
    releases.get('docs')?.();
    await handle.close();
  }
});

test('runtime server filters state and events by workspace', async (t) => {
  let stateWorkspace = null;
  let eventWorkspace = null;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: (_session, options) => {
          stateWorkspace = options.workspace;
          return { status: 'idle', workspace: options.workspace };
        },
        listEvents: (options) => {
          eventWorkspace = options.workspace;
          return [{ id: 'e1', workspace: options.workspace }];
        },
      },
      getContext: async (workspace) => ({
        workspace,
        session: { workspace },
        running: false,
        currentAbortController: null,
      }),
      run: async () => {},
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const state = await fetch(`http://127.0.0.1:${handle.port}/state?workspace=juno`);
    assert.equal(state.status, 200);
    assert.equal((await state.json()).workspace, 'juno');
    assert.equal(stateWorkspace, 'juno');

    const events = await fetch(`http://127.0.0.1:${handle.port}/events?workspace=docs`);
    assert.equal(events.status, 200);
    assert.deepEqual(await events.json(), { events: [{ id: 'e1', workspace: 'docs' }] });
    assert.equal(eventWorkspace, 'docs');
  } finally {
    await handle.close();
  }
});

test('runtime server exposes manual resume endpoint', async (t) => {
  let resumedWorkspace = null;
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
      run: async () => {},
      resume: async ({ workspace }) => {
        resumedWorkspace = workspace;
        return { resumed: 1, interrupted: 0, workspaces: [{ workspace, resumed: true }] };
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/resume?workspace=juno`, {
      method: 'POST',
    });
    assert.equal(response.status, 202);
    assert.equal(resumedWorkspace, 'juno');
    assert.deepEqual(await response.json(), {
      resumed: 1,
      interrupted: 0,
      workspaces: [{ workspace: 'juno', resumed: true }],
    });
  } finally {
    await handle.close();
  }
});
