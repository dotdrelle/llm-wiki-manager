import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../../core/agentEvents.js';
import { createDispatcher } from '../dispatcher.js';
import { createFakeRuntimeProvider } from './fakeRuntimeProvider.js';
import { discoverRuntimeProviderAgents } from './runtimeProviders.js';

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  }
  throw new Error('condition not met in time');
}

function externalAssignment(provider, agentInstanceId) {
  return {
    agentInstanceId,
    serverName: null,
    providerKind: 'external-runtime',
    runtimeId: provider.runtime,
    runtimeProvider: provider,
    description: { agentType: 'external-runtime' },
  };
}

test('dispatcher routes an external-runtime assignment to RuntimeProvider.execute', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.echo', operations: ['run'] }] });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = { workspace: 'test', mcp: {}, activities: {} };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 1 });

  const result = await dispatcher.execute(
    { id: 'echo-a', label: 'Echo A', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-donna-1', attempt: { attemptId: 'echo-a:attempt-1', locks: [], release() {} } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.taskId, 'echo-a');
  assert.equal(result.agentInstanceId, agents[0].agentInstanceId);
  assert.equal(result.status, 'completed');
  assert.ok(result.jobId);

  const started = session.agentEvents?.find((event) => event.type === 'task.started');
  assert.ok(started, 'task.started was dispatched');
  assert.equal(started.payload.jobId, result.jobId);
});

test('dispatcher cancels the external run through the provider when the signal aborts', async () => {
  const provider = createFakeRuntimeProvider({ autoCompleteMs: 10_000 });
  const cancelledRunIds = [];
  const originalCancel = provider.cancel.bind(provider);
  provider.cancel = async (runId) => {
    cancelledRunIds.push(String(runId));
    return originalCancel(runId);
  };
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = { workspace: 'test', mcp: {}, activities: {} };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 5 });
  const controller = new AbortController();

  const executing = dispatcher.execute(
    { id: 'echo-b', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { signal: controller.signal, attempt: { attemptId: 'echo-b:attempt-1', locks: [], release() {} } },
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  controller.abort();

  await assert.rejects(() => executing);
  assert.equal(cancelledRunIds.length, 1, 'the external run was cancelled via the provider');
});

test('dispatcher maps runtime message events into assistant_message', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.echo', operations: ['run'] }] });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = { workspace: 'test', mcp: {}, activities: {} };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 1 });

  await dispatcher.execute(
    { id: 'echo-c', label: 'Echo C', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-donna-2', attempt: { attemptId: 'echo-c:attempt-1', locks: [], release() {} } },
  );

  const message = session.agentEvents?.find((event) => event.type === 'assistant_message');
  assert.ok(message, 'an assistant_message was dispatched');
  assert.match(String(message.payload?.content ?? ''), /completed/);
});

test('dispatcher propagates a planExpansionRequest from the external runtime result (agent -> DAG)', async () => {
  const provider = {
    runtime: 'deepagents',
    async describe() { return { runtime: 'deepagents', version: '0.6.10', protocolVersion: '1', health: 'available' }; },
    async discoverCapabilities() { return [{ name: 'agent.review', operations: ['run'] }]; },
    async execute() { return { runId: 'review-1', status: 'running' }; },
    async status() {
      return {
        runId: 'review-1',
        status: 'completed',
        result: {
          status: 'completed',
          planExpansionRequest: {
            capability: 'knowledge.pipeline',
            operation: 'build',
            objective: 'Build the deliverables the review flagged as stale.',
            arguments: { templates: ['templates/rapport.md'] },
            insertAfterTasks: ['review-a'],
          },
        },
      };
    },
    async cancel() {},
    async approve() {},
    subscribe() { return () => {}; },
  };
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);
  const session = { workspace: 'test', mcp: {}, activities: {} };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 1 });

  const result = await dispatcher.execute(
    { id: 'review-a', requiredCapability: 'agent.review', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-donna-3', attempt: { attemptId: 'review-a:attempt-1', locks: [], release() {} } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.planExpansionRequest.capability, 'knowledge.pipeline');
  assert.equal(result.planExpansionRequest.operation, 'build');
});

test('dispatcher waits for a covered grant before unblocking the runtime HITL', async () => {
  const provider = createFakeRuntimeProvider({ requireApproval: true });
  const approvedCalls = [];
  const originalApprove = provider.approve.bind(provider);
  provider.approve = async (runId, decision) => {
    approvedCalls.push({ runId, decision });
    return originalApprove(runId, decision);
  };
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = { workspace: 'test', mcp: {}, activities: {} };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 5 });
  const runId = 'run-donna-approve';

  const executing = dispatcher.execute(
    { id: 'echo-h', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId, attempt: { attemptId: 'echo-h:attempt-1', locks: [], release() {} } },
  );

  await waitFor(() => (session.agentEvents ?? []).some((event) => event.type === 'approval.requested'));
  assert.equal(approvedCalls.length, 0, 'the runtime is not unblocked before a human grant');

  dispatchAgentEvent(session, createAgentEvent('approval.granted', {
    origin: 'test',
    runId,
    payload: { id: 'grant-run', scope: 'run', runId, approvalClasses: [] },
  }));

  const result = await executing;
  assert.equal(result.ok, true);
  assert.equal(approvedCalls.length, 1, 'approve is called once, only after the grant covers the request');
  assert.equal(approvedCalls[0].decision.approved, true);
  assert.deepEqual(approvedCalls[0].decision.scope, ['default']);
});

test('dispatcher gates a mutating runtime capability on approval (per-capability HITL)', async () => {
  const provider = createFakeRuntimeProvider({
    capabilities: [{ name: 'agent.research', operations: ['run'], mutationClass: 'ingest' }],
  });
  const approvedCalls = [];
  const originalApprove = provider.approve.bind(provider);
  provider.approve = async (runId, decision) => {
    approvedCalls.push({ runId, decision });
    return originalApprove(runId, decision);
  };
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = { workspace: 'test', mcp: {}, activities: {} };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 5 });
  const runId = 'run-donna-approve-2';

  const executing = dispatcher.execute(
    { id: 'research-a', requiredCapability: 'agent.research', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId, attempt: { attemptId: 'research-a:attempt-1', locks: [], release() {} } },
  );

  await waitFor(() => (session.agentEvents ?? []).some((event) => event.type === 'approval.requested'));
  assert.equal(approvedCalls.length, 0, 'the runtime is not unblocked before a human grant');

  dispatchAgentEvent(session, createAgentEvent('approval.granted', {
    origin: 'test',
    runId,
    payload: { id: 'grant-run-2', scope: 'run', runId, approvalClasses: [] },
  }));

  const result = await executing;
  assert.equal(result.ok, true);
  assert.equal(approvedCalls.length, 1);
  assert.deepEqual(approvedCalls[0].decision.scope, ['ingest'], 'the unblock carries the announced mutation class');
});

test("end-user dry-run: 'plan' completes without any approval; 'run' pauses with the ⏸ banner until /approve", async () => {
  const provider = createFakeRuntimeProvider({
    capabilities: [{ name: 'agent.plan', operations: ['plan', 'run'], defaultRequiresApproval: true }],
  });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);

  // Dry-run path: operation 'plan'
  const drySession = { workspace: 'test', mcp: {}, activities: {} };
  const dryDispatcher = createDispatcher({ session: drySession, pollIntervalMs: 1 });
  const dry = await dryDispatcher.execute(
    { id: 'plan-a', label: 'Propose', requiredCapability: 'agent.plan', operation: 'plan', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-plan-a', attempt: { attemptId: 'plan-a:attempt-1', locks: [], release() {} } },
  );
  assert.equal(dry.ok, true);
  assert.equal(dry.status, 'completed');
  assert.ok(
    !(drySession.agentEvents ?? []).some((event) => event.type === 'approval.requested'),
    'a dry-run never asks for approval',
  );
  assert.ok(
    (drySession.agentEvents ?? []).some((event) => event.type === 'assistant_message'
      && /completed/.test(String(event.payload?.content ?? ''))),
    'the proposal is reported back to the user',
  );

  // Live path: operation 'run'
  const liveSession = { workspace: 'test', mcp: {}, activities: {} };
  const liveDispatcher = createDispatcher({ session: liveSession, pollIntervalMs: 5 });
  const runId = 'run-plan-b';
  const executing = liveDispatcher.execute(
    { id: 'plan-b', label: 'Apply', requiredCapability: 'agent.plan', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId, attempt: { attemptId: 'plan-b:attempt-1', locks: [], release() {} } },
  );

  await waitFor(() => (liveSession.agentEvents ?? []).some((event) => event.type === 'approval.requested'));
  const banner = (liveSession.agentEvents ?? []).find((event) => event.type === 'assistant_message'
    && /Approval required/.test(String(event.payload?.content ?? '')));
  assert.ok(banner, 'the ⏸ banner is shown before anything runs');

  dispatchAgentEvent(liveSession, createAgentEvent('approval.granted', {
    origin: 'test',
    runId,
    payload: { id: 'grant-plan-b', scope: 'run', runId, approvalClasses: [] },
  }));

  const result = await executing;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
});

test('dispatcher sends the active profile model with the run', async () => {
  const provider = createFakeRuntimeProvider();
  const requests = [];
  const originalExecute = provider.execute.bind(provider);
  provider.execute = async (request) => {
    requests.push(request);
    return originalExecute(request);
  };
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = {
    workspace: 'test',
    mcp: {
      wiki: {
        status: 'connected',
        url: 'http://localhost:3335/mcp/',
        headers: { Authorization: 'Bearer wiki-token' },
        tools: [
          { name: 'wiki_search_context' },
          { name: 'wiki_read_page' },
          { name: 'wiki_write_page' },
        ],
      },
    },
    activities: {},
    wikircConfig: { llm: { baseUrl: 'http://llm:11434/v1', model: 'qwen3:14b', apiKey: 'secret', temperature: 0.3 } },
    language: 'fr',
  };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 1 });

  await dispatcher.execute(
    { id: 'echo-i', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-donna-4', attempt: { attemptId: 'echo-i:attempt-1', locks: [], release() {} } },
  );

  assert.deepEqual(requests[0].model, {
    baseUrl: 'http://llm:11434/v1',
    model: 'qwen3:14b',
    apiKey: 'secret',
    temperature: 0.3,
  });
  assert.equal(requests[0].language, 'fr', 'the workspace language travels with the run');
  assert.deepEqual(requests[0].mcp, [{
    name: 'wiki',
    url: 'http://localhost:3335/mcp/',
    headers: { Authorization: 'Bearer wiki-token' },
    tools: ['wiki_search_context', 'wiki_read_page'],
  }], 'the wiki MCP travels per run, read tools only — write tools never leave');
  assert.match(requests[0].systemPrompt ?? '', /agentic analysis engine/);
  assert.match(requests[0].systemPrompt ?? '', /agent\.echo/);
  assert.match(requests[0].systemPrompt ?? '', /Reply in the workspace language: fr/);
});

test('dispatcher sends the wiki MCP pool with its bearer token (runtime eyes)', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.echo', operations: ['run'] }] });
  const received = [];
  const originalExecute = provider.execute.bind(provider);
  provider.execute = async (request) => {
    received.push(request);
    return originalExecute(request);
  };
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = {
    workspace: 'test',
    workspacePath: null,
    language: 'fr',
    wikircConfig: { llm: { model: 'openai/gpt-test', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' } },
    mcp: {
      wiki: {
        url: 'http://127.0.0.1:3201/mcp',
        status: 'connected',
        token: 'wiki-access-key',
        tools: [{ name: 'wiki_list_pages' }, { name: 'wiki_read_page' }, { name: 'wiki_write_page' }, { name: 'wiki_add_source' }],
      },
    },
    activities: {},
  };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 1 });

  await dispatcher.execute(
    { id: 'echo-a', label: 'Echo A', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-donna-eyes', attempt: { attemptId: 'echo-a:attempt-1', locks: [], release() {} } },
  );

  assert.equal(received.length, 1);
  const mcp = received[0].mcp ?? [];
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0].name, 'wiki');
  // Without the Authorization header the workspace MCP server rejects the
  // gateway's connection ("invalid or missing bearer token") and the Deep
  // Agent runs blind — the first gateway E2E failed exactly this way.
  assert.equal(mcp[0].headers?.Authorization, 'Bearer wiki-access-key');
  assert.ok(mcp[0].tools.includes('wiki_list_pages'));
  assert.ok(!mcp[0].tools.includes('wiki_write_page'), 'write tools never reach the runtime');
  assert.ok(!mcp[0].tools.includes('wiki_add_source'));
});

test('dispatcher sends the active profile model with the run', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.echo', operations: ['run'] }] });
  const received = [];
  const originalExecute = provider.execute.bind(provider);
  provider.execute = async (request) => {
    received.push(request);
    return originalExecute(request);
  };
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = {
    workspace: 'test',
    workspacePath: null,
    language: 'fr',
    wikircConfig: { llm: { model: 'openai/gpt-test', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', temperature: 0.2 } },
    mcp: {},
    activities: {},
  };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 1 });

  await dispatcher.execute(
    { id: 'echo-a', label: 'Echo A', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-donna-model', attempt: { attemptId: 'echo-a:attempt-1', locks: [], release() {} } },
  );

  assert.equal(received[0].model.model, 'openai/gpt-test');
  assert.equal(received[0].model.baseUrl, 'http://127.0.0.1:9/v1');
  assert.equal(received[0].model.apiKey, 'k');
  assert.equal(received[0].model.temperature, 0.2);
});

test('dispatcher announces when the runtime is dispatched without its wiki MCP pool', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.echo', operations: ['run'] }] });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'fake', provider }]);
  const session = {
    workspace: 'test',
    workspacePath: null,
    language: 'fr',
    wikircConfig: { llm: { model: 'openai/gpt-test', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' } },
    mcp: {},
    activities: {},
  };
  const dispatcher = createDispatcher({ session, pollIntervalMs: 1 });

  await dispatcher.execute(
    { id: 'echo-a', label: 'Echo A', requiredCapability: 'agent.echo', operation: 'run', arguments: {} },
    externalAssignment(provider, agents[0].agentInstanceId),
    { runId: 'run-donna-blind', attempt: { attemptId: 'echo-a:attempt-1', locks: [], release() {} } },
  );

  const blind = session.agentEvents?.filter((event) => event.type === 'runtime_log'
    && event.payload?.event === 'runtime.blind');
  assert.equal(blind.length, 1, 'running blind must be announced exactly once');
  assert.match(String(blind[0].payload?.detail ?? ''), /no workspace wiki MCP pool/);
});
