import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeepAgentsProvider } from './deepAgentsProvider.js';
import { RUNTIME_PROTOCOL_VERSION, assertRuntimeProvider } from './runtimeProvider.js';
import { resolveRuntimeProviders } from './runtimeProviders.js';

function jsonResponse(status, data, ok = status < 400) {
  return { ok, status, json: async () => data };
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const key = `${options.method ?? 'GET'} ${parsed.pathname}`;
    calls.push({ method: options.method ?? 'GET', path: parsed.pathname, body: options.body, url });
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return handler(parsed, options);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function sseBody(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  }
  throw new Error('condition not met in time');
}

test('describe reports available and reads the version from /health', async () => {
  const fetchImpl = mockFetch({
    'GET /health': () => jsonResponse(200, { ok: true, version: '0.6.10' }),
  });
  const provider = createDeepAgentsProvider({ id: 'deepagents', endpoint: 'http://agent-runtime:8080', fetchImpl });
  assertRuntimeProvider(provider);

  const description = await provider.describe();
  assert.equal(description.runtime, 'deepagents');
  assert.equal(description.version, '0.6.10');
  assert.equal(description.protocolVersion, RUNTIME_PROTOCOL_VERSION);
  assert.equal(description.health, 'available');
});

test('describe reports unavailable when /health fails, without throwing', async () => {
  const fetchImpl = mockFetch({}); // every route 404
  const provider = createDeepAgentsProvider({ id: 'deepagents', endpoint: 'http://agent-runtime:8080', fetchImpl });

  const description = await provider.describe();
  assert.equal(description.health, 'unavailable');
  assert.ok(description.error, 'the reason is carried');
});

test('discoverCapabilities fetches /capabilities', async () => {
  const fetchImpl = mockFetch({
    'GET /capabilities': () => jsonResponse(200, [{ name: 'agent.review', operations: ['run'] }]),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  assert.deepEqual(await provider.discoverCapabilities(), [{ name: 'agent.review', operations: ['run'] }]);
});

test('discoverCapabilities uses the static config when provided', async () => {
  const fetchImpl = mockFetch({});
  const provider = createDeepAgentsProvider({
    endpoint: 'http://agent-runtime:8080',
    capabilities: [{ name: 'agent.review', operations: ['run'] }],
    fetchImpl,
  });

  assert.deepEqual(await provider.discoverCapabilities(), [{ name: 'agent.review', operations: ['run'] }]);
  assert.equal(fetchImpl.calls.length, 0, 'no HTTP call when capabilities are static');
});

test('execute POSTs /runs and returns the runId', async () => {
  const fetchImpl = mockFetch({
    'POST /runs': () => jsonResponse(200, { runId: 'run-1', status: 'running' }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  const run = await provider.execute({
    objective: 'analyse JUNO',
    operation: 'run',
    arguments: {},
    model: { baseUrl: 'http://llm:11434/v1', model: 'qwen3:14b', apiKey: 'secret' },
  });
  assert.deepEqual(run, { runId: 'run-1', status: 'running' });
  assert.equal(fetchImpl.calls[0].path, '/runs');
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.objective, 'analyse JUNO');
  assert.deepEqual(sent.model, { baseUrl: 'http://llm:11434/v1', model: 'qwen3:14b', apiKey: 'secret' });
});

test('status and cancel hit the run-scoped routes', async () => {
  const fetchImpl = mockFetch({
    'GET /runs/run-1': () => jsonResponse(200, { runId: 'run-1', status: 'completed', result: { status: 'completed' } }),
    'POST /runs/run-1/cancel': () => jsonResponse(200, { ok: true }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  const status = await provider.status('run-1');
  assert.equal(status.status, 'completed');
  assert.equal(status.result.status, 'completed');

  await provider.cancel('run-1');
  assert.equal(fetchImpl.calls.at(-1).path, '/runs/run-1/cancel');
});

test('status forwards the top-level error reported by the gateway', async () => {
  const fetchImpl = mockFetch({
    'GET /runs/run-2': () => jsonResponse(200, { runId: 'run-2', status: 'failed', error: 'Unable to infer model provider' }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  const status = await provider.status('run-2');
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'Unable to infer model provider');
});

test('subscribe parses the SSE stream and forwards normalized events', async () => {
  const fetchImpl = mockFetch({
    'GET /runs/run-1/events': () => ({
      ok: true,
      status: 200,
      body: sseBody([
        { type: 'tool_started', tool: 'wiki_search' },
        { type: 'tool_finished', tool: 'wiki_search', resultSummary: '17 found' },
      ]),
    }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  const events = [];
  provider.subscribe('run-1', (event) => events.push(event));

  await waitFor(() => events.length === 2);
  assert.deepEqual(events.map((event) => event.type), ['tool_started', 'tool_finished']);
  assert.equal(events[0].tool, 'wiki_search');
});

test('approve posts the decision to the run approval route', async () => {
  const fetchImpl = mockFetch({
    'POST /runs/run-1/approve': () => jsonResponse(200, { ok: true }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  await provider.approve('run-1', { approved: true, scope: ['email'] });

  assert.equal(fetchImpl.calls.at(-1).path, '/runs/run-1/approve');
  const sent = JSON.parse(fetchImpl.calls.at(-1).body);
  assert.equal(sent.approved, true);
  assert.deepEqual(sent.scope, ['email']);
});

test('the deepagents factory is reachable from the agentRuntimes config', () => {
  const { providers, skipped } = resolveRuntimeProviders([
    { id: 'deepagents', type: 'deepagents', endpoint: 'http://agent-runtime:8080', capabilities: [{ name: 'agent.review', operations: ['run'] }] },
  ]);

  assert.equal(skipped.length, 0);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].type, 'deepagents');
  assertRuntimeProvider(providers[0].provider);
});
