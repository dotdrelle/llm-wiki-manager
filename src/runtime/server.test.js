import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { createInteractiveSession, ensureInteractiveAssistantMessage } from '../cli/wiki-manager.js';
import { approvalRequestFromStatus, runtimeState, startRuntimeServer as startRuntimeServerImpl } from './server.js';

// Most server tests exercise endpoint behavior rather than authentication. Keep
// them independent from a developer's WIKI_MANAGER_RUNTIME_TOKEN environment;
// auth-specific tests can still override this default explicitly.
function startRuntimeServer(options) {
  return startRuntimeServerImpl({ token: '', ...options });
}

test('approval fallback derives classes from waiting tasks when the approval queue is missing', () => {
  const request = approvalRequestFromStatus({
    workspace: 'acme',
    runId: 'run-1',
    planRevision: 4,
    approvals: [],
    plan: [
      { id: 'apply', status: 'waiting_approval', requiresApproval: true, approvalClass: 'mutation' },
      { id: 'export', status: 'waiting_approval', requiresApproval: true, approvalClass: 'external-write' },
    ],
  });

  assert.deepEqual(request.approvalClasses, ['mutation', 'external-write']);
  assert.equal(request.scope, 'run');
  assert.equal(request.planRevision, 4);
});

test('approval fallback excludes tasks blocked by failed dependencies', () => {
  const request = approvalRequestFromStatus({
    workspace: 'acme', runId: 'run-1', planRevision: 4, approvals: [],
    plan: [
      { id: 'failed-source', status: 'failed' },
      { id: 'blocked-write', status: 'waiting_approval', requiresApproval: true, approvalClass: 'external-write', dependsOn: ['failed-source'] },
    ],
  });

  assert.deepEqual(request.approvalClasses, ['default']);
});

test('interactive runtime sessions isolate canonical run state', () => {
  const mcp = { wiki: { status: 'connected' } };
  const session = createInteractiveSession({ session: {
    workspace: 'demo', workspacePath: '/workspace/demo', mcp,
    llm: { invoke() {} }, commands: ['status'], packageJson: {}, queueStore: {},
    _currentRunIdentity: { runId: 'run-1' }, headlessPlan: [{ id: 'task-1' }],
    agentProjection: { status: 'running' }, _agentProjectionState: {},
    controlQueue: [{}], planPatches: [{}], _requestApproval() {}, agents: [{}], agentRegistry: {},
  } }, { runtimeUrl: 'http://127.0.0.1:7788', turnId: 'turn-1' });

  assert.equal(session.mcp, mcp);
  assert.deepEqual(session.runtime, { url: 'http://127.0.0.1:7788' });
  assert.equal(session.headlessPlan, null);
  assert.deepEqual(session.activities, {});
  assert.deepEqual(session.jobQueue, []);
  for (const key of [
    '_currentRunIdentity', 'agentProjection', '_agentProjectionState', 'controlQueue',
    'planPatches', '_requestApproval', 'agents', 'agentRegistry',
  ]) assert.equal(Object.hasOwn(session, key), false, `${key} must not leak`);
});

test('interactive turns publish a fallback assistant message exactly once', () => {
  const published = [];
  const session = { agentEvents: [], _onAgentEvent: (event) => published.push(event) };
  assert.equal(ensureInteractiveAssistantMessage(session, 'Réponse concise.', {
    turnId: 'turn-1', workspace: 'demo',
  }), true);
  assert.equal(ensureInteractiveAssistantMessage(session, 'Réponse dupliquée.', {
    turnId: 'turn-1', workspace: 'demo',
  }), false);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'assistant_message');
  assert.equal(published[0].origin, 'runtime_turn');
  assert.equal(published[0].payload.content, 'Réponse concise.');
});

test('runtime state rebuilds interactive conversation from persisted events', () => {
  const user = {
    ...createAgentEvent('user_message', { origin: 'runtime_turn', turnId: 'turn-1', workspace: 'demo', payload: { content: 'Bonjour' } }),
    origin: 'runtime_turn', turnId: 'turn-1', workspace: 'demo',
  };
  const assistant = {
    ...createAgentEvent('assistant_message', { origin: 'runtime_turn', turnId: 'turn-1', workspace: 'demo', payload: { content: 'Salut !' } }),
    origin: 'runtime_turn', turnId: 'turn-1', workspace: 'demo',
  };
  const session = { agentProjection: { conversation: [] } };
  const store = {
    getState: (receivedSession) => {
      assert.equal(receivedSession, session);
      return { status: 'idle', conversation: [] };
    },
    listEvents: ({ workspace }) => {
      assert.equal(workspace, 'demo');
      return [user, assistant];
    },
  };

  const state = runtimeState({ workspace: 'demo', session, running: false }, store, { workspace: 'demo' });

  assert.deepEqual(state.conversation.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Bonjour' },
    { role: 'assistant', content: 'Salut !' },
  ]);
});

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

test('runtime health exposes active CA certificate environment', async (t) => {
  const previousCacert = process.env.WIKI_MANAGER_CACERT_PATH;
  const previousNodeExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
  process.env.WIKI_MANAGER_CACERT_PATH = '/tmp/wiki-manager-test-ca.pem';
  process.env.NODE_EXTRA_CA_CERTS = '/tmp/wiki-manager-test-ca.pem';
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/health`, {
      headers: { authorization: 'Bearer runtime-secret' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.cacertPath, '/tmp/wiki-manager-test-ca.pem');
    assert.equal(body.nodeExtraCaCerts, '/tmp/wiki-manager-test-ca.pem');
  } finally {
    await handle.close();
    if (previousCacert === undefined) delete process.env.WIKI_MANAGER_CACERT_PATH;
    else process.env.WIKI_MANAGER_CACERT_PATH = previousCacert;
    if (previousNodeExtraCaCerts === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousNodeExtraCaCerts;
  }
});

test('runtime server shutdown endpoint closes the listener', async (t) => {
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      token: 'runtime-secret',
      exitOnShutdown: false,
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

  const url = `http://127.0.0.1:${handle.port}`;
  const response = await fetch(`${url}/shutdown`, {
    method: 'POST',
    headers: { authorization: 'Bearer runtime-secret' },
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).shutdown, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(fetch(`${url}/health`, {
    headers: { authorization: 'Bearer runtime-secret' },
  }));
});

test('runtime server exposes task assignment attempt and result read endpoints', async (t) => {
  const taskId = 'run-1:task-a';
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
        listTasks: ({ runId }) => runId === 'run-1' ? [{ id: taskId, runId, status: 'done' }] : [],
        listTaskAttempts: ({ taskId: requested }) => requested === taskId ? [{
          attemptId: 'attempt-1',
          taskId,
          runId: 'run-1',
          status: 'done',
          jobId: 'job-1',
        }] : [],
        getTaskResult: ({ taskId: requested }) => requested === taskId ? {
          attemptId: 'attempt-1',
          taskId,
          status: 'succeeded',
          outputRefs: [{ type: 'file', ref: 'deliverables/a.md' }],
          metrics: { durationMs: 7 },
        } : null,
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
    const headers = { authorization: 'Bearer runtime-secret' };
    const tasksResponse = await fetch(`http://127.0.0.1:${handle.port}/runs/run-1/tasks`, { headers });
    assert.equal(tasksResponse.status, 200);
    assert.deepEqual((await tasksResponse.json()).tasks, [{ id: taskId, runId: 'run-1', status: 'done' }]);

    const encodedTaskId = encodeURIComponent(taskId);
    const attemptsResponse = await fetch(`http://127.0.0.1:${handle.port}/tasks/${encodedTaskId}/attempts`, { headers });
    assert.equal(attemptsResponse.status, 200);
    assert.equal((await attemptsResponse.json()).attempts[0].attemptId, 'attempt-1');

    const resultResponse = await fetch(`http://127.0.0.1:${handle.port}/tasks/${encodedTaskId}/result`, { headers });
    assert.equal(resultResponse.status, 200);
    assert.equal((await resultResponse.json()).result.metrics.durationMs, 7);
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
    const [first, second] = await Promise.all([
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'first' }),
      }),
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Messages during an active run are now CLASSIFIED (observe answers
        // immediately, cancel aborts…) — enqueueing a future run is the
        // explicit intent.
        body: JSON.stringify({ input: 'second', intent: 'enqueue' }),
      }),
    ]);

    assert.deepEqual([first.status, second.status], [202, 202]);
    const bodies = [await first.json(), await second.json()];
    const acceptedRun = bodies.find((body) => body.runId && body.accepted);
    const queuedRun = bodies.find((body) => body.kind === 'enqueue_run');
    assert.equal(queuedRun.accepted, true);
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
      body: JSON.stringify({ input: 'build', workspace: 'acme', evaluate: false, replans: 1 }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.match(body.runId, /^[0-9a-f-]{36}$/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receivedBody.runId, body.runId);
    assert.equal(receivedBody.workspace, 'acme');
    assert.equal(receivedBody.evaluate, false);
    assert.equal(receivedBody.replans, 1);
  } finally {
    await handle.close();
  }
});

test('runtime server kill aborts active run and interrupts workspace work', async (t) => {
  let abortSeen = false;
  let cancelCalled = false;
  let interruptArgs = null;
  let taskCancelArgs = null;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'running' }),
        listEvents: () => [],
        interruptRuns: (args) => {
          interruptArgs = args;
          return 1;
        },
        cancelActiveTasksForInterruptedRuns: (args) => {
          taskCancelArgs = args;
          return 3;
        },
      },
      session: { controlQueue: [{ id: 'control-1', workspace: 'docs', status: 'queued' }] },
      run: async (_context, _body, { signal }) => {
        signal.addEventListener('abort', () => { abortSeen = true; }, { once: true });
        await new Promise(() => {});
      },
      cancel: async () => {
        cancelCalled = true;
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
    const base = `http://127.0.0.1:${handle.port}`;
    const runResponse = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'build', workspace: 'docs' }),
    });
    assert.equal(runResponse.status, 202);

    const killResponse = await fetch(`${base}/kill?workspace=docs`, { method: 'POST' });
    assert.equal(killResponse.status, 202);
    assert.deepEqual(await killResponse.json(), {
      killed: true,
      workspace: 'docs',
      runId: null,
      runs: 1,
      tasks: 3,
      queued: 1,
    });
    assert.equal(abortSeen, true);
    assert.equal(cancelCalled, true);
    assert.equal(interruptArgs.workspace, 'docs');
    assert.equal(interruptArgs.runId, null);
    assert.deepEqual(taskCancelArgs, { workspace: 'docs', runId: null });
  } finally {
    await handle.close();
  }
});

test('runtime server kill succeeds without an active run', async (t) => {
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle' }),
        listEvents: () => [],
        interruptRuns: () => 0,
        cancelActiveTasksForInterruptedRuns: () => 0,
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/kill?workspace=docs`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      killed: true,
      workspace: 'docs',
      runId: null,
      runs: 0,
      tasks: 0,
      queued: 0,
    });
  } finally {
    await handle.close();
  }
});

test('runtime server kill can target a specific run id', async (t) => {
  let interruptArgs = null;
  let taskCancelArgs = null;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle' }),
        listEvents: () => [],
        interruptRuns: (args) => {
          interruptArgs = args;
          return 1;
        },
        cancelActiveTasksForInterruptedRuns: (args) => {
          taskCancelArgs = args;
          return 2;
        },
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/kill?workspace=docs&runId=run-1`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).runId, 'run-1');
    assert.equal(interruptArgs.runId, 'run-1');
    assert.deepEqual(taskCancelArgs, { workspace: 'docs', runId: 'run-1' });
  } finally {
    await handle.close();
  }
});

test('runtime server state exposes active run identity while running', async (t) => {
  let releaseRun;
  const context = {
    workspace: 'acme',
    session: { workspace: 'acme' },
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
    const runResponse = await fetch(`http://127.0.0.1:${handle.port}/run?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'build' }),
    });
    acceptedRun = await runResponse.json();
    const stateResponse = await fetch(`http://127.0.0.1:${handle.port}/state?workspace=acme`);
    const state = await stateResponse.json();
    assert.equal(state.status, 'running');
    assert.equal(state.running, true);
    assert.equal(state.runId, acceptedRun.runId);
    assert.equal(state.workspace, 'acme');
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
    const [acme, docs] = await Promise.all([
      fetch(`${url}?workspace=acme`, {
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
    assert.deepEqual([acme.status, docs.status], [202, 202]);

    const queued = await fetch(`${url}?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'third', intent: 'enqueue' }),
    });
    assert.equal(queued.status, 202);
    assert.equal((await queued.json()).kind, 'enqueue_run');
    assert.deepEqual(runWorkspaces.sort(), ['acme', 'docs']);
  } finally {
    releases.get('acme')?.();
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
    const state = await fetch(`http://127.0.0.1:${handle.port}/state?workspace=acme`);
    assert.equal(state.status, 200);
    assert.equal((await state.json()).workspace, 'acme');
    assert.equal(stateWorkspace, 'acme');

    const events = await fetch(`http://127.0.0.1:${handle.port}/events?workspace=docs`);
    assert.equal(events.status, 200);
    assert.deepEqual(await events.json(), { events: [{ id: 'e1', workspace: 'docs' }] });
    assert.equal(eventWorkspace, 'docs');
  } finally {
    await handle.close();
  }
});

test('runtime server exposes a correlated audit trail endpoint', async (t) => {
  let auditArgs = null;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'idle' }),
        listEvents: () => [],
        listAuditTrail: (options) => {
          auditArgs = options;
          return [{ sequence: 1, type: 'tool_call_started', runId: options.runId, taskId: 'task-a' }];
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/audit?workspace=docs&runId=run-1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.workspace, 'docs');
    assert.equal(body.runId, 'run-1');
    assert.deepEqual(body.audit, [{ sequence: 1, type: 'tool_call_started', runId: 'run-1', taskId: 'task-a' }]);
    assert.deepEqual(auditArgs, { workspace: 'docs', runId: 'run-1' });
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/resume?workspace=acme`, {
      method: 'POST',
    });
    assert.equal(response.status, 202);
    assert.equal(resumedWorkspace, 'acme');
    assert.deepEqual(await response.json(), {
      resumed: 1,
      interrupted: 0,
      workspaces: [{ workspace: 'acme', resumed: true }],
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/approve?workspace=acme&runId=run-1&itemId=item-1`, {
      method: 'POST',
    });
    assert.equal(response.status, 202);
    assert.deepEqual(approved, {
      workspace: 'acme',
      workspaceId: 'acme',
      runId: 'run-1',
      itemId: 'item-1',
      approvalId: null,
      scope: null,
      taskId: null,
      groupId: null,
      planRevision: null,
      approvalClasses: [],
    });
    assert.deepEqual(await response.json(), { approved: true, runId: 'run-1', itemId: 'item-1' });
  } finally {
    await handle.close();
  }
});

test('runtime server exposes control status and explanation', async (t) => {
  const session = {
    workspace: 'acme',
    controlQueue: [{ id: 'control-1', workspace: 'acme', status: 'queued', input: 'later' }],
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
        workspace: 'acme',
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
    const status = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`);
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.status, 'idle');
    assert.equal(statusBody.running, false);
    assert.equal(statusBody.controlQueue[0].id, 'control-1');

    const explain = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
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
    workspace: 'acme',
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
        workspace: 'acme',
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
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
    workspace: 'acme',
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
        workspace: 'acme',
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
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

test('runtime server control message handles approve and cancel intents during an active run', async (t) => {
  const session = {
    workspace: 'acme',
    controlQueue: [],
  };
  const abortController = new AbortController();
  let cancelled = false;
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
        workspace: 'acme',
        session,
        running: true,
        currentAbortController: abortController,
      }),
      cancel: async () => { cancelled = true; },
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
    const approveResponse = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'valide tout' }),
    });
    assert.equal(approveResponse.status, 200);
    assert.equal((await approveResponse.json()).kind, 'approve');

    const cancelResponse = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'annule le run' }),
    });
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).kind, 'cancel');
    assert.equal(cancelled, true);
    assert.equal(abortController.signal.aborted, true);
    assert.equal(session.controlQueue.length, 0);
  } finally {
    await handle.close();
  }
});

test('runtime server control message records active plan mutation as a proposal', async (t) => {
  const session = {
    workspace: 'acme',
    controlQueue: [],
  };
  dispatchAgentEvent(session, createAgentEvent('run_started', {
    origin: 'runtime',
    runId: 'run-mutate',
    workspace: 'acme',
  }));
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'tool',
    runId: 'run-mutate',
    workspace: 'acme',
    payload: {
      steps: [{ step: 1, id: 'generate', description: 'Generate', status: 'running' }],
    },
  }));
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          ...session.agentProjection,
          status: session.agentProjection?.status ?? 'running',
          queue: [],
          runs: [{ id: 'run-mutate', workspace: 'acme', status: 'running' }],
          runId: 'run-mutate',
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'acme',
        session,
        running: true,
        currentAbortController: new AbortController(),
        currentRunId: 'run-mutate',
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'Ajoute un envoi après chaque génération' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.kind, 'modify_run');
    assert.equal(body.proposal.status, 'proposed');
    assert.equal(body.proposal.input, 'Ajoute un envoi après chaque génération');
    assert.equal(session.agentProjection.planPatches[0].status, 'proposed');
    assert.ok(session.agentEvents.some((event) => event.type === 'control_message_received'));
    assert.ok(session.agentEvents.some((event) => event.type === 'plan_patch_proposed'));
    const approveResponse = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve_patch', patchId: body.proposal.id }),
    });
    assert.equal(approveResponse.status, 202);
    const approved = await approveResponse.json();
    assert.equal(approved.kind, 'approve_patch');
    // plan_set (revision 0->1) then the approved patch application (1->2).
    assert.equal(session.agentProjection.planRevision, 2);
    assert.deepEqual(session.agentProjection.plan.map((step) => step.id), ['generate', session.agentProjection.plan[1].id]);
    assert.deepEqual(session.agentProjection.plan[1].dependsOn, ['generate']);
    assert.ok(session.agentEvents.some((event) => event.type === 'plan_patch_approved'));
    assert.ok(session.agentEvents.some((event) => event.type === 'plan_patch_applied'));
    assert.equal(session.controlQueue.length, 0);
    assert.equal(runCount, 0);
  } finally {
    await handle.close();
  }
});

test('runtime server control message reports ambiguity without starting a run', async (t) => {
  const session = {
    workspace: 'acme',
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
        workspace: 'acme',
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
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
    workspace: 'acme',
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
        workspace: 'acme',
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue', input: 'run from control queue' }),
    });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receivedBody.input, 'run from control queue');
    assert.equal(receivedBody.workspace, 'acme');
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
    workspace: 'acme',
    controlQueue: [{ id: 'control-existing', workspace: 'acme', status: 'queued', input: 'resume queued control' }],
  };
  const events = [];
  session._onAgentEvent = (event) => events.push(event);
  const context = {
    workspace: 'acme',
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
    workspace: 'acme',
    session: { workspace: 'acme', wikirc: { profile: 'default' } },
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
    const profiles = await fetch(`http://127.0.0.1:${handle.port}/config/profiles?workspace=acme`);
    assert.equal(profiles.status, 200);
    assert.deepEqual(await profiles.json(), { profiles: ['default', 'vpn'], active: 'default' });

    const use = await fetch(`http://127.0.0.1:${handle.port}/config/use?workspace=acme`, {
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
        workspace: 'acme',
        session: { workspace: 'acme' },
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
    const response = await fetch(`http://127.0.0.1:${handle.port}/config/use?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'vpn' }),
    });
    assert.equal(response.status, 409);
  } finally {
    await handle.close();
  }
});

test('runtime server answers control messages posted to /run during an active run', async (t) => {
  let releaseRun;
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
      session: {},
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
    const url = `http://127.0.0.1:${handle.port}/run`;
    const started = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'lance le pipeline' }),
    });
    assert.equal(started.status, 202);

    // A status question must be answered NOW, not parked until the run ends
    // (regression: serve UI got no result until the job finished/stopped).
    const observe = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'où en est le run ?' }),
    });
    assert.equal(observe.status, 200);
    const observeBody = await observe.json();
    assert.equal(observeBody.kind, 'observe');
    assert.ok(String(observeBody.explanation ?? '').length > 0, 'observe must carry an explanation');

    // A cancel must abort the active run instead of being enqueued.
    const cancel = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'annule le run' }),
    });
    assert.equal(cancel.status, 200);
    const cancelBody = await cancel.json();
    assert.equal(cancelBody.kind, 'cancel');
    assert.equal(cancelBody.accepted, true);
  } finally {
    releaseRun?.();
    await handle.close();
  }
});

test('runtime server accepts an interactive turn without starting a run', async (t) => {
  const context = { workspace: 'demo', session: {}, running: false };
  let received = null;
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
      getContext: async () => context,
      run: async () => assert.fail('/turn must not start a runtime run'),
      turn: async (_context, body, meta) => { received = { body, meta }; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/turn`, {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Quels documents sont en attente ?', workspace: 'demo' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.kind, 'turn');
    assert.match(body.turnId, /^turn-/);
    await context.interactiveTurn;
    assert.equal(received.body.input, 'Quels documents sont en attente ?');
    assert.equal(received.meta.turnId, body.turnId);
    assert.equal(context.running, false);
  } finally {
    await handle.close();
  }
});

test('runtime server keeps read-only chat turns available during an active run', async (t) => {
  const context = { workspace: 'demo', session: {}, running: true };
  let received = null;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      token: 'runtime-secret',
      store: {
        dbPath: ':memory:',
        getState: () => ({ status: 'running' }),
        listEvents: () => [],
      },
      getContext: async () => context,
      run: async () => assert.fail('/turn must not start another runtime run'),
      turn: async (_context, body, meta) => { received = { body, meta }; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/turn`, {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Quel est le statut CME ?', mode: 'chat', workspace: 'demo' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.kind, 'turn');
    await context.interactiveTurn;
    assert.equal(received.body.mode, 'chat');
    assert.equal(received.body.input, 'Quel est le statut CME ?');
    assert.equal(received.meta.turnId, body.turnId);
    assert.equal(context.running, true);
  } finally {
    await handle.close();
  }
});

test('runtime health reports active runs across workspaces', async (t) => {
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: { dbPath: ':memory:', getState: () => ({ status: 'idle' }), listEvents: () => [] },
      session: {},
      // The shell reads this at exit: shutting down its own runtime must not
      // kill a run that is supposed to survive the shell.
      listActiveRuns: () => [{ workspace: 'juno', runId: 'run-1234abcd' }],
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const health = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json();
    assert.deepEqual(health.activeRuns, [{ workspace: 'juno', runId: 'run-1234abcd' }]);
  } finally {
    await handle.close();
  }
});
