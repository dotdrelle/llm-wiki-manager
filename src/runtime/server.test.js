import assert from 'node:assert/strict';
import test from 'node:test';
import { startRuntimeServer } from './server.js';

test('runtime server checks bearer and x-runtime-token credentials', async (t) => {
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      token: 'runtime-secret',
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle' }),
        listEvents: () => [],
      },
      session: {},
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
    const url = `http://127.0.0.1:${handle.port}/health`;

    const missing = await fetch(url);
    assert.equal(missing.status, 401);

    const bearer = await fetch(url, {
      headers: { authorization: 'Bearer runtime-secret' },
    });
    assert.equal(bearer.status, 200);

    const legacy = await fetch(url, {
      headers: { 'x-runtime-token': 'runtime-secret' },
    });
    assert.equal(legacy.status, 200);
  } finally {
    await handle.close();
  }
});

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

test('runtime server state exposes active run identity while running', async (t) => {
  let releaseRun;
  const context = {
    workspace: 'juno',
    session: { workspace: 'juno' },
    running: false,
    currentAbortController: null,
    currentRunId: null,
  };
  let acceptedRun;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle', plan: [] }),
        listEvents: () => [],
      },
      getContext: async () => context,
      run: async () => {
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
    const runResponse = await fetch(`http://127.0.0.1:${handle.port}/run?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'build' }),
    });
    acceptedRun = await runResponse.json();
    const stateResponse = await fetch(`http://127.0.0.1:${handle.port}/state?workspace=juno`);
    const state = await stateResponse.json();
    assert.equal(state.status, 'running');
    assert.equal(state.running, true);
    assert.equal(state.runId, acceptedRun.runId);
    assert.equal(state.workspace, 'juno');
  } finally {
    releaseRun?.();
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

test('runtime server exposes approval endpoint', async (t) => {
  let approved = null;
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
      approve: async (request) => {
        approved = request;
        return { approved: true, runId: request.runId, itemId: request.itemId };
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/approve?workspace=juno&runId=run-1&itemId=item-1`, {
      method: 'POST',
    });
    assert.equal(response.status, 202);
    assert.deepEqual(approved, {
      workspace: 'juno',
      runId: 'run-1',
      itemId: 'item-1',
      approvalId: null,
    });
    assert.deepEqual(await response.json(), { approved: true, runId: 'run-1', itemId: 'item-1' });
  } finally {
    await handle.close();
  }
});

test('runtime server exposes control status and explanation', async (t) => {
  const session = {
    workspace: 'juno',
    controlQueue: [{ id: 'control-1', workspace: 'juno', status: 'queued', input: 'later' }],
  };
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'idle',
          plan: [{ step: 1, description: 'Check status', status: 'pending' }],
          queue: [],
          controlQueue: session.controlQueue,
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session,
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
    const status = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`);
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.status, 'idle');
    assert.equal(statusBody.running, false);
    assert.equal(statusBody.controlQueue[0].id, 'control-1');

    const explain = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'explain' }),
    });
    assert.equal(explain.status, 200);
    assert.match((await explain.json()).explanation, /control request/);
  } finally {
    await handle.close();
  }
});

test('runtime server control enqueue emits events but does not patch an active plan or start a run', async (t) => {
  const session = {
    workspace: 'juno',
    controlQueue: [],
  };
  const events = [];
  session._onAgentEvent = (event) => events.push(event);
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'running',
          plan: [{ step: 1, description: 'Active step', status: 'running' }],
          queue: [],
          controlQueue: session.controlQueue,
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session,
        running: true,
        currentAbortController: new AbortController(),
      }),
      run: async () => { runCount += 1; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', input: 'run this after current work' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.item.status, 'queued');
    assert.equal(body.controlQueue.length, 1);
    assert.equal(body.plan[0].description, 'Active step');
    assert.equal(session.controlQueue[0].input, 'run this after current work');
    assert.equal(events.filter((event) => event.type === 'control_enqueued').length, 1);
    assert.equal(runCount, 0);
  } finally {
    await handle.close();
  }
});

test('runtime server control message observes an active run without enqueueing', async (t) => {
  const session = {
    workspace: 'juno',
    controlQueue: [],
  };
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'running',
          plan: [{ step: 1, description: 'Build documents', status: 'running' }],
          queue: [],
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session,
        running: true,
        currentAbortController: new AbortController(),
      }),
      run: async () => { runCount += 1; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'Où en est le build ?' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.kind, 'observe');
    assert.match(body.explanation, /Build documents/);
    assert.equal(session.controlQueue.length, 0);
    assert.equal(runCount, 0);
  } finally {
    await handle.close();
  }
});

test('runtime server control message records active plan mutation as a proposal', async (t) => {
  const session = {
    workspace: 'juno',
    controlQueue: [],
  };
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'running',
          plan: [{ step: 1, description: 'Generate', status: 'running' }],
          queue: [],
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session,
        running: true,
        currentAbortController: new AbortController(),
      }),
      run: async () => { runCount += 1; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'Ajoute un envoi après chaque génération' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.kind, 'mutate');
    assert.equal(body.proposal.status, 'proposed');
    assert.equal(session.controlProposals[0].input, 'Ajoute un envoi après chaque génération');
    assert.equal(session.controlQueue.length, 0);
    assert.equal(runCount, 0);
  } finally {
    await handle.close();
  }
});

test('runtime server control message reports ambiguity without starting a run', async (t) => {
  const session = {
    workspace: 'juno',
    controlQueue: [],
  };
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'running',
          plan: [{ step: 1, description: 'Generate', status: 'running' }],
          queue: [],
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session,
        running: true,
        currentAbortController: new AbortController(),
      }),
      run: async () => { runCount += 1; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'Lance aussi la publication' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.kind, 'ambiguous');
    assert.equal(body.choices.length, 3);
    assert.equal(session.controlQueue.length, 0);
    assert.equal(runCount, 0);
  } finally {
    await handle.close();
  }
});

test('runtime server drains queued control requests when idle', async (t) => {
  const session = {
    workspace: 'juno',
    controlQueue: [],
  };
  const events = [];
  session._onAgentEvent = (event) => events.push(event);
  let receivedBody = null;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'idle',
          plan: [],
          queue: [],
          controlQueue: session.controlQueue,
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session,
        running: false,
        currentAbortController: null,
      }),
      run: async (_context, body) => {
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', input: 'run from control queue' }),
    });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receivedBody.input, 'run from control queue');
    assert.equal(receivedBody.workspace, 'juno');
    assert.match(receivedBody.runId, /^[0-9a-f-]{36}$/);
    assert.equal(session.controlQueue[0].status, 'running');
    assert.equal(session.controlQueue[0].runId, receivedBody.runId);
    assert.deepEqual(events.map((event) => event.type), ['control_enqueued', 'control_started']);
  } finally {
    await handle.close();
  }
});

test('runtime server handle drains a pre-existing hydrated control request', async (t) => {
  const session = {
    workspace: 'juno',
    controlQueue: [{ id: 'control-existing', workspace: 'juno', status: 'queued', input: 'resume queued control' }],
  };
  const events = [];
  session._onAgentEvent = (event) => events.push(event);
  const context = {
    workspace: 'juno',
    session,
    running: false,
    currentAbortController: null,
  };
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
      getContext: async () => context,
      run: async (_context, body) => {
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
    assert.equal(handle.drainControl(context), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receivedBody.input, 'resume queued control');
    assert.equal(session.controlQueue[0].status, 'running');
    assert.equal(events[0].type, 'control_started');
  } finally {
    await handle.close();
  }
});

test('runtime server exposes config profile list and switch endpoints', async (t) => {
  const context = {
    workspace: 'juno',
    session: { workspace: 'juno', wikirc: { profile: 'default' } },
    running: false,
    currentAbortController: null,
  };
  let switchedProfile = null;
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
      getContext: async () => context,
      run: async () => {},
      configProfiles: async () => ({ profiles: ['default', 'vpn'], active: context.session.wikirc.profile }),
      useConfigProfile: async (_context, profile) => {
        switchedProfile = profile;
        context.session.wikirc.profile = profile;
        return { ok: true, active: profile, config: { llm: { model: 'model-vpn' } } };
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
    const profiles = await fetch(`http://127.0.0.1:${handle.port}/config/profiles?workspace=juno`);
    assert.equal(profiles.status, 200);
    assert.deepEqual(await profiles.json(), { profiles: ['default', 'vpn'], active: 'default' });

    const use = await fetch(`http://127.0.0.1:${handle.port}/config/use?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'vpn' }),
    });
    assert.equal(use.status, 200);
    assert.equal(switchedProfile, 'vpn');
    assert.deepEqual(await use.json(), { ok: true, active: 'vpn', config: { llm: { model: 'model-vpn' } } });
  } finally {
    await handle.close();
  }
});

test('runtime server rejects config switching while a run is active', async (t) => {
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'running' }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'juno',
        session: { workspace: 'juno' },
        running: true,
        currentAbortController: null,
      }),
      run: async () => {},
      useConfigProfile: async () => ({ ok: true }),
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/config/use?workspace=juno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'vpn' }),
    });
    assert.equal(response.status, 409);
  } finally {
    await handle.close();
  }
});
