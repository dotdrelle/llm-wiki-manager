import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRuntimeStateToShellSession,
  createSession,
  conversationMessages,
  recordRuntimeUnavailableAgentInput,
  runLine,
  runtimeStatusLine,
  runtimeUnavailableAgentMessage,
  shouldHandleFreeTextLocally,
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
  assert.deepEqual(session.agentProjection.conversation, [
    { role: 'user', content: 'Build docs' },
    { role: 'assistant', content: 'Working.' },
  ]);
  assert.equal(session.headlessPlan[0].description, 'Build');
  assert.equal(session.activities['production:job-1'].status, 'running');
  assert.equal(session.productionActivity.jobId, 'job-1');
  assert.equal(session.jobQueue[0].id, 'q-1');
  assert.equal(session.workflow.nodes[0].id, 'task:build');
  assert.equal(session.workflow.relations[0].type, 'contains');
  assert.deepEqual(session.workflow.waitingReasons, ['queue:q-1']);
  assert.deepEqual(conversationMessages(session), []);
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

test('submitRuntimeRun reports queued runs from non-blocking runtime', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(pathOf(url), '/run');
    return jsonResponse(202, {
      accepted: true,
      queued: true,
      kind: 'enqueue_run',
      item: { id: 'control-1', status: 'queued' },
    });
  });
  try {
    const session = createSession();
    const outcome = await submitRuntimeRun('build the doc', { runtime: { url: 'http://runtime.test' }, session });
    assert.equal(outcome.kind, 'queued');
    assert.equal(outcome.result.item.id, 'control-1');
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

test('runLine does not update workspace profile before Donna handles the request', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'donna-profile-shell-'));
  mkdirSync(join(workspacePath, '.wiki'), { recursive: true });
  try {
    const session = createSession();
    session.workspace = 'docs';
    session.workspacePath = workspacePath;
    const result = await runLine('ajoute a mon profil que les statuts Docker sont rendus en tableau', {
      agent: null,
      packageJson: { version: 'test' },
      session,
      chatMode: true,
    });

    assert.equal(result.exit, false);
    assert.equal(existsSync(join(workspacePath, '.wiki', 'profile.md')), false);
    assert.notDeepEqual(conversationMessages(session).map((message) => message.role), ['user', 'donna']);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
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
    runtimeStatusLine({ error: 'token mismatch' }, { workspace: 'acme' }),
    'runtime: disconnected: token mismatch',
  );
  assert.equal(
    runtimeUnavailableAgentMessage({ error: 'token mismatch' }),
    '⚠ Runtime indisponible : token mismatch — /agent désactivé, /chat reste possible',
  );
});

test('/run kill posts to the runtime kill endpoint', async () => {
  let calledUrl = null;
  const restore = stubFetch(async (url) => {
    calledUrl = new URL(String(url));
    return jsonResponse(202, { killed: true, runs: 1, tasks: 2 });
  });
  try {
    const session = createSession();
    session.workspace = 'docs';

    const result = await runLine('/run kill', {
      agent: null,
      packageJson: { version: 'test' },
      session,
      runtime: { url: 'http://runtime.test' },
    });

    assert.equal(result.exit, false);
    assert.equal(calledUrl.pathname, '/kill');
    assert.equal(calledUrl.searchParams.get('workspace'), 'docs');
    assert.match(conversationMessages(session).at(-1).content, /Runtime kill requested: 1 run, 2 tasks cancelled/);
  } finally {
    restore();
  }
});

test('/queue cancel on a runtime workflow id points to run cancellation commands', async () => {
  const session = createSession();
  session.workspace = 'docs';
  session.jobQueue = [];
  session.workflow = {
    nodes: [{ id: 'task:runtime-a', type: 'task', label: 'Runtime task', status: 'pending' }],
    relations: [],
  };

  const result = await runLine('/queue cancel task:runtime-a', {
    agent: null,
    packageJson: { version: 'test' },
    session,
  });

  assert.equal(result.exit, false);
  assert.match(conversationMessages(session).at(-1).content, /Item géré par le runtime/);
  assert.match(conversationMessages(session).at(-1).content, /\/run kill/);
});

test('free text routing keeps questions local and sends actions to the runtime', () => {
  const session = createSession();
  session.llm = { completeWithTools: () => {} };

  // The original incident: a config question must never start a run.
  const question = shouldHandleFreeTextLocally('donne moi la config du cme', session);
  assert.equal(question.local, true);
  assert.equal(question.classification.kind, 'observe');

  const smallTalk = shouldHandleFreeTextLocally('bonjour', session);
  assert.equal(smallTalk.local, true);

  const action = shouldHandleFreeTextLocally('lance le pipeline complet', session);
  assert.equal(action.local, false);
  assert.equal(action.classification.kind, 'start_run');
});

test('free text routing defers to the runtime when a run is active or LLM is down', () => {
  const session = createSession();
  session.llm = { completeWithTools: () => {} };
  session.agentProjection = { status: 'running', activities: [], conversation: [] };
  // Active run → existing 409/control-message path, even for questions.
  assert.equal(shouldHandleFreeTextLocally('où en est le run', session).local, false);

  const offline = createSession();
  offline.llm = null;
  const fallback = shouldHandleFreeTextLocally('donne moi la config du cme', offline);
  assert.equal(fallback.local, false);
  assert.match(fallback.fallbackReason ?? '', /LLM unavailable/);
});
