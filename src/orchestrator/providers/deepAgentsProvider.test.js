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

test('discoverCapabilities keeps the configured metadata but only for capabilities the gateway serves', async () => {
  const fetchImpl = mockFetch({
    'GET /capabilities': () => jsonResponse(200, [
      { name: 'agent.review', operations: ['run'] },
      { name: 'agent.notify', operations: ['run'] },
    ]),
  });
  const provider = createDeepAgentsProvider({
    endpoint: 'http://agent-runtime:8080',
    capabilities: [
      { name: 'agent.review', operations: ['run'], aliases: ['audit'] },
      { name: 'agent.research', operations: ['run'], mutationClass: 'ingest' },
      { name: 'agent.notify', operations: ['run'], defaultRequiresApproval: true },
    ],
    fetchImpl,
  });

  const offered = await provider.discoverCapabilities();
  assert.equal(fetchImpl.calls.length, 1, 'the gateway is always asked what it serves');
  assert.deepEqual(offered.map((item) => item.name), ['agent.review', 'agent.notify']);
  assert.equal(offered[0].aliases[0], 'audit', 'the configured metadata is what the resolver routes on');
  assert.deepEqual(provider.lastDiscovery, {
    served: ['agent.review', 'agent.notify'],
    configured: ['agent.review', 'agent.research', 'agent.notify'],
    missing: ['agent.research'],
    extra: [],
  });
});

test('discoverCapabilities with no static config serves the gateway list as-is', async () => {
  const fetchImpl = mockFetch({
    'GET /capabilities': () => jsonResponse(200, [{ name: 'agent.review', operations: ['run'] }]),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  assert.deepEqual(await provider.discoverCapabilities(), [{ name: 'agent.review', operations: ['run'] }]);
  assert.deepEqual(provider.lastDiscovery.missing, []);
  assert.equal(provider.lastDiscovery.configured, null);
});

test('execute POSTs /runs and returns the runId', async () => {
  const fetchImpl = mockFetch({
    'POST /runs': () => jsonResponse(200, { runId: 'run-1', status: 'running' }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });

  const run = await provider.execute({
    objective: 'analyze the demo workspace',
    operation: 'run',
    arguments: {},
    model: { baseUrl: 'http://llm:11434/v1', model: 'qwen3:14b', apiKey: 'secret' },
  });
  assert.deepEqual(run, { runId: 'run-1', status: 'running' });
  assert.equal(fetchImpl.calls[0].path, '/runs');
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.objective, 'analyze the demo workspace');
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
  // A single attempt: this test is about parsing, not reconnection. The mock
  // stream carries no terminal event, so the provider would otherwise reconnect
  // (and the mock would re-deliver) until its budget ran out.
  const provider = createDeepAgentsProvider({
    endpoint: 'http://agent-runtime:8080', fetchImpl, streamRetries: 1, streamBackoffMs: 1,
  });

  const events = [];
  provider.subscribe('run-1', (event) => events.push(event));

  await waitFor(() => events.length >= 2);
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ['tool_started', 'tool_finished']);
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

// ── Lot 0: a broken stream must not mean "silence forever" ──────────────────

test('an event type this manager does not know still reaches the listener', async () => {
  const fetchImpl = mockFetch({
    'GET /runs/run-6/events': () => ({
      ok: true,
      status: 200,
      body: sseBody([
        { type: 'phase_started', phase: 'discover', sequence: 1 },
        { type: 'run_completed', sequence: 2 },
      ]),
    }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });
  const events = [];
  provider.subscribe('run-6', (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'phase_started'));
  assert.equal(events.find((event) => event.type === 'phase_started').phase, 'discover');
});

test('a dropped stream reconnects from the cursor and never repeats an event', async () => {
  let connections = 0;
  const fetchImpl = mockFetch({
    'GET /runs/run-1/events': () => {
      connections += 1;
      if (connections === 1) {
        return {
          ok: true,
          status: 200,
          body: sseBody([
            { type: 'stream_epoch', epoch: 'epoch-a' },
            { type: 'tool_started', tool: 'wiki_search', sequence: 5 },
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseBody([
          { type: 'stream_epoch', epoch: 'epoch-a' },
          { type: 'run_completed', sequence: 6 },
        ]),
      };
    },
  });
  const provider = createDeepAgentsProvider({
    endpoint: 'http://agent-runtime:8080', fetchImpl, streamRetries: 3, streamBackoffMs: 1,
  });
  const events = [];
  const unsubscribe = provider.subscribe('run-1', (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'run_completed'));
  unsubscribe();

  assert.equal(connections, 2, 'the stream was reconnected once');
  assert.match(fetchImpl.calls[1].url, /after=5/, 'the cursor travels back');
  assert.match(fetchImpl.calls[1].url, /epoch=epoch-a/, 'the epoch travels back');
  assert.equal(events.filter((event) => event.type === 'tool_started').length, 1, 'no duplicate delivery');
  assert.equal(events.filter((event) => event.type === 'stream_epoch').length, 0, 'the epoch frame is consumed, never forwarded');
});

test('a stream epoch change stops the subscription with an announced reason', async () => {
  let connections = 0;
  const fetchImpl = mockFetch({
    'GET /runs/run-2/events': () => {
      connections += 1;
      return {
        ok: true,
        status: 200,
        body: sseBody([{ type: 'stream_epoch', epoch: connections === 1 ? 'epoch-a' : 'epoch-b' }]),
      };
    },
  });
  const provider = createDeepAgentsProvider({
    endpoint: 'http://agent-runtime:8080', fetchImpl, streamRetries: 5, streamBackoffMs: 1,
  });
  const events = [];
  provider.subscribe('run-2', (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'degraded'));
  assert.equal(connections, 2, 'it stopped after the mismatch');
  assert.match(events.find((event) => event.type === 'degraded').cause, /epoch changed/);
});

test('a purged run ends the subscription with an announced reason', async () => {
  const fetchImpl = mockFetch({}); // 404 on every route
  const provider = createDeepAgentsProvider({
    endpoint: 'http://agent-runtime:8080', fetchImpl, streamRetries: 5, streamBackoffMs: 1,
  });
  const events = [];
  provider.subscribe('run-gone', (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'degraded'));
  assert.match(events.find((event) => event.type === 'degraded').cause, /not known to the runtime/);
});

test('a stream that keeps failing announces the give-up', async () => {
  const fetchImpl = mockFetch({
    'GET /runs/run-4/events': () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const provider = createDeepAgentsProvider({
    endpoint: 'http://agent-runtime:8080', fetchImpl, streamRetries: 2, streamBackoffMs: 1,
  });
  const events = [];
  provider.subscribe('run-4', (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'degraded' && /gave up/.test(event.cause)));
});

test('a malformed frame is journalled instead of silently skipped', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {not json\n\n'));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'run_completed' })}\n\n`));
      controller.close();
    },
  });
  const fetchImpl = mockFetch({
    'GET /runs/run-5/events': () => ({ ok: true, status: 200, body }),
  });
  const provider = createDeepAgentsProvider({ endpoint: 'http://agent-runtime:8080', fetchImpl });
  const events = [];
  provider.subscribe('run-5', (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'degraded' && /malformed/.test(event.cause)));
  assert.ok(events.some((event) => event.type === 'run_completed'), 'the good frame still arrives');
});
