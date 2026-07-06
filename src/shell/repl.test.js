import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRuntimeStateToShellSession,
  createSession,
  conversationMessages,
  recordRuntimeUnavailableAgentInput,
  runtimeStatusLine,
  runtimeUnavailableAgentMessage,
  submitRuntimeRun,
} from './repl.js';

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

function pathOf(url) {
  return new URL(String(url)).pathname;
}

test('applyRuntimeStateToShellSession projects runtime state into shell session', () => {
  const session = createSession();
  session.workspace = 'docs';

  const applied = applyRuntimeStateToShellSession(session, {
    status: 'running',
    conversation: [
      { role: 'user', content: 'Build docs' },
      { role: 'assistant', content: 'Working.' },
    ],
    plan: [{ step: 1, description: 'Build', status: 'running' }],
    activities: [{
      key: 'production:job-1',
      id: 'job-1',
      source: 'production',
      label: 'Production: build',
      status: 'running',
      terminal: false,
    }],
    queue: [{ id: 'q-1', status: 'waiting' }],
    workflow: {
      nodes: [{ id: 'task:build', type: 'task', label: 'Build', status: 'running' }],
      relations: [{ type: 'contains', from: 'run:run-1', to: 'task:build' }],
      waitingReasons: ['queue:q-1'],
      warnings: ['legacy_sequential_plan'],
    },
    logs: ['agentic-loop: turn 1/20'],
  });

  assert.equal(applied, true);
  assert.equal(session.agentProjection.status, 'running');
  assert.equal(session.headlessPlan[0].description, 'Build');
  assert.equal(session.activities['production:job-1'].status, 'running');
  assert.equal(session.productionActivity.jobId, 'job-1');
  assert.equal(session.jobQueue[0].id, 'q-1');
  assert.equal(session.workflow.nodes[0].id, 'task:build');
  assert.equal(session.workflow.relations[0].type, 'contains');
  assert.deepEqual(session.workflow.waitingReasons, ['queue:q-1']);
  assert.deepEqual(conversationMessages(session), [
    { role: 'user', content: 'Build docs' },
    { role: 'donna', content: 'Working.' },
  ]);
});

test('submitRuntimeRun reports acceptance without throwing', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(pathOf(url), '/run');
    return jsonResponse(202, { accepted: true, runId: 'run-1' });
  });
  try {
    const session = createSession();
    const outcome = await submitRuntimeRun('build the doc', { runtime: { url: 'http://runtime.test' }, session });
    assert.deepEqual(outcome, { kind: 'accepted' });
  } finally {
    restore();
  }
});

test('submitRuntimeRun routes busy runtime input through the control lane', async () => {
  let controlBody = null;
  const restore = stubFetch(async (url, init) => {
    const path = pathOf(url);
    if (path === '/run') return jsonResponse(409, { error: 'A runtime run is already active.' });
    if (path === '/control') {
      controlBody = JSON.parse(String(init.body));
      return jsonResponse(200, { accepted: true, kind: 'observe', explanation: 'Runtime run is active.' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    const session = createSession();
    const outcome = await submitRuntimeRun('Où en est le build ?', { runtime: { url: 'http://runtime.test' }, session });
    assert.equal(outcome.kind, 'observe');
    assert.equal(outcome.result.explanation, 'Runtime run is active.');
    assert.deepEqual(controlBody, { action: 'message', input: 'Où en est le build ?' });
  } finally {
    restore();
  }
});

test('submitRuntimeRun reports a non-409 error without throwing or calling /control', async () => {
  let controlCalled = false;
  const restore = stubFetch(async (url) => {
    if (pathOf(url) === '/control') controlCalled = true;
    return jsonResponse(503, { error: 'runtime unavailable' });
  });
  try {
    const session = createSession();
    const outcome = await submitRuntimeRun('build the doc', { runtime: { url: 'http://runtime.test' }, session });
    assert.equal(outcome.kind, 'error');
    assert.match(outcome.message, /503/);
    assert.equal(controlCalled, false);
  } finally {
    restore();
  }
});

test('agent mode without runtime records a visible error instead of falling back locally', () => {
  const session = createSession();
  session.chatMode = false;

  const message = recordRuntimeUnavailableAgentInput(session, 'salut', { error: 'port 7788 already in use' });

  assert.equal(message, '⚠ Runtime indisponible : port 7788 already in use — /agent désactivé, /chat reste possible');
  assert.deepEqual(conversationMessages(session), [
    { role: 'user', content: 'salut' },
    { role: 'command', content: message },
  ]);
});

test('runtime status exposes the disconnected reason', () => {
  assert.equal(
    runtimeStatusLine({ error: 'token mismatch' }, { workspace: 'juno' }),
    'runtime: disconnected: token mismatch',
  );
  assert.equal(
    runtimeUnavailableAgentMessage({ error: 'token mismatch' }),
    '⚠ Runtime indisponible : token mismatch — /agent désactivé, /chat reste possible',
  );
});
