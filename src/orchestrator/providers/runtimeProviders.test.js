import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilityRegistryForSession, createCapabilityRegistry } from '../capabilityRegistry.js';
import { CapabilityUnavailableError, resolve } from '../capabilityResolver.js';
import { createAssignmentManager } from '../assignmentManager.js';
import { resolveObjective } from '../objectiveResolver.js';
import { createFakeRuntimeProvider } from './fakeRuntimeProvider.js';
import {
  discoverRuntimeProviderAgents,
  discoverRuntimeProvidersOnce,
  loadAgentRuntimesConfig,
  resolveRuntimeProviders,
} from './runtimeProviders.js';

function mcpAgent(agentInstanceId, capabilityId) {
  return {
    agentInstanceId,
    health: 'available',
    description: {
      contractVersion: '1',
      agentType: agentInstanceId.split('-')[0],
      agentInstanceId,
      displayName: agentInstanceId,
      capabilities: [{
        id: capabilityId,
        version: '1',
        description: capabilityId,
        inputSchema: {},
        outputSchema: {},
        supportedOperations: ['run'],
      }],
    },
  };
}

test('discovery projects a live runtime into synthetic agents', async () => {
  const provider = createFakeRuntimeProvider({
    runtime: 'deepagents',
    capabilities: [{ name: 'agent.review', operations: ['run'] }],
  });

  const { agents, unavailable } = await discoverRuntimeProviderAgents([
    { id: 'deepagents', provider },
  ]);

  assert.equal(unavailable.length, 0);
  assert.equal(agents.length, 1);
  const agent = agents[0];
  assert.equal(agent.agentInstanceId, 'deepagents::agent.review');
  assert.equal(agent.providerKind, 'external-runtime');
  assert.equal(agent.health, 'available');
  assert.equal(agent.serverName, null);
  assert.equal(agent.runtimeProvider, provider);
  assert.equal(agent.description.capabilities[0].id, 'agent.review');
});

test('a down runtime yields no agents and is reported', async () => {
  const provider = createFakeRuntimeProvider({ available: false });

  const { agents, unavailable } = await discoverRuntimeProviderAgents([
    { id: 'deepagents', provider },
  ]);

  assert.equal(agents.length, 0);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].runtimeId, 'deepagents');
});

test('the capability registry carries providerKind and runtimeProvider for external entries', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.review', operations: ['run'] }] });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);

  const registry = createCapabilityRegistry({ agents });

  const providers = registry.providersFor('agent.review');
  assert.equal(providers.length, 1);
  assert.equal(providers[0].providerKind, 'external-runtime');
  assert.equal(providers[0].runtimeProvider, provider);
});

test('resolve routes agent.* to the external runtime agent', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.review', operations: ['run'] }] });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);
  const registry = createCapabilityRegistry({ agents });

  const assignment = resolve('agent.review', { workspaceConfig: {}, registry });

  assert.equal(assignment.agentInstanceId, 'deepagents::agent.review');
});

test('assignmentManager produces an external-runtime assignment with a null serverName', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.review', operations: ['run'] }] });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);
  const session = {
    capabilityRegistry: createCapabilityRegistry({ agents }),
    agentRegistrySnapshot: [],
    agents: [],
  };
  const assign = createAssignmentManager({ session });

  const assignment = await assign.assign({
    id: 'review-a',
    requiredCapability: 'agent.review',
    operation: 'run',
    arguments: {},
  });

  assert.equal(assignment.agentInstanceId, 'deepagents::agent.review');
  assert.equal(assignment.serverName, null);
  assert.equal(assignment.runtimeProvider, provider);
  assert.equal(assignment.providerKind, 'external-runtime');
});

test('a down runtime is isolated: agent.* resolves nowhere while MCP capabilities still do', async () => {
  const { agents } = await discoverRuntimeProviderAgents([
    { id: 'deepagents', provider: createFakeRuntimeProvider({ available: false }) },
  ]);
  assert.equal(agents.length, 0);

  const session = {
    agentRegistry: { snapshot: () => [mcpAgent('production-main', 'knowledge.update')] },
    agentRegistrySnapshot: [],
  };
  const registry = capabilityRegistryForSession(session);

  // The external capability is absent because its runtime is down.
  assert.throws(
    () => resolve('agent.review', { workspaceConfig: {}, registry }),
    (error) => error instanceof CapabilityUnavailableError && error.reason === 'capability_not_found',
  );
  // The MCP capability is unaffected.
  const mcpAssignment = resolve('knowledge.update', { workspaceConfig: {}, registry });
  assert.equal(mcpAssignment.agentInstanceId, 'production-main');
});

function sessionWithEvents() {
  return { workspace: 'test', mcp: {}, agentEvents: [], activities: {} };
}

test('resolveRuntimeProviders maps enabled entries and skips unknown types', () => {
  const { providers, skipped } = resolveRuntimeProviders([
    { id: 'fake-1', type: 'fake', capabilities: [{ name: 'agent.echo', operations: ['run'] }] },
    { id: 'mystery', type: 'mystery-runtime' },
    { id: 'off', type: 'fake', enabled: false },
  ]);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'fake-1');
  assert.equal(providers[0].type, 'fake');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'mystery');
});

test('loadAgentRuntimesConfig reads both array and object forms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runtimes-'));
  try {
    writeFileSync(join(dir, 'agent-runtimes.json'), JSON.stringify({ runtimes: [{ id: 'a', type: 'fake' }] }));
    assert.deepEqual(loadAgentRuntimesConfig({ stateDir: dir }), [{ id: 'a', type: 'fake' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAgentRuntimesConfig returns [] for a missing or unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runtimes-'));
  try {
    assert.deepEqual(loadAgentRuntimesConfig({ stateDir: dir, env: {} }), []);
    writeFileSync(join(dir, 'agent-runtimes.json'), '{not json');
    const logs = [];
    assert.deepEqual(loadAgentRuntimesConfig({ stateDir: dir, log: (message) => logs.push(message), env: {} }), []);
    assert.equal(logs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GATEWAY_ENABLED implies the deepagents runtime with the bearer token (one switch)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runtimes-'));
  try {
    const config = loadAgentRuntimesConfig({
      stateDir: dir,
      env: { GATEWAY_ENABLED: 'true', GATEWAY_PORT: '7789', GATEWAY_AUTH_TOKEN: 'tok-1' },
    });
    const implied = config.find((entry) => entry.type === 'deepagents');
    assert.ok(implied, 'the gateway is declared when GATEWAY_ENABLED is set');
    assert.equal(implied.enabled, true);
    assert.equal(implied.endpoint, 'http://localhost:7789');
    assert.deepEqual(implied.headers, { Authorization: 'Bearer tok-1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the local gateway bearer is injected only into the manager-owned host-local entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runtimes-'));
  try {
    writeFileSync(join(dir, 'agent-runtimes.json'), JSON.stringify({
      runtimes: [
        { id: 'local', type: 'deepagents', endpoint: 'http://127.0.0.1:7789', enabled: true },
        { id: 'shared', type: 'deepagents', endpoint: 'https://gateway.partner.example', enabled: true },
        { id: 'otherport', type: 'deepagents', endpoint: 'http://localhost:9999', enabled: true },
      ],
    }));
    const config = loadAgentRuntimesConfig({
      stateDir: dir,
      env: { GATEWAY_ENABLED: 'true', GATEWAY_PORT: '7789', GATEWAY_AUTH_TOKEN: 'tok-local' },
    });
    const byId = Object.fromEntries(config.map((entry) => [entry.id, entry]));
    assert.deepEqual(byId.local.headers, { Authorization: 'Bearer tok-local' });
    assert.equal(byId.shared.headers, undefined, 'a foreign gateway host must never receive the local token');
    assert.equal(byId.otherport.headers, undefined, 'a non-gateway port is not the manager-owned gateway');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit enabled deepagents entry wins over the implied one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runtimes-'));
  try {
    writeFileSync(join(dir, 'agent-runtimes.json'), JSON.stringify({
      runtimes: [{ id: 'deepagents', type: 'deepagents', endpoint: 'http://custom:9000', enabled: true }],
    }));
    const config = loadAgentRuntimesConfig({ stateDir: dir, env: { GATEWAY_ENABLED: 'true' } });
    assert.equal(config.length, 1);
    assert.equal(config[0].endpoint, 'http://custom:9000');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverRuntimeProvidersOnce populates session.runtimeProviderAgents and announces down runtimes', async () => {
  const session = sessionWithEvents();

  const agents = await discoverRuntimeProvidersOnce(session, {
    config: [
      { id: 'fake', type: 'fake', capabilities: [{ name: 'agent.echo', operations: ['run'] }] },
      { id: 'down', type: 'fake', available: false },
    ],
  });

  assert.equal(agents.length, 1);
  assert.equal(session.runtimeProviderAgents.length, 1);
  assert.equal(session.runtimeProviderAgents[0].agentInstanceId, 'fake::agent.echo');

  const logs = (session.agentEvents ?? []).filter((event) => event.type === 'runtime_log');
  assert.ok(
    logs.some((event) => String(event.payload?.message ?? '').includes('down')
      && String(event.payload?.message ?? '').includes('unavailable')),
    'a down runtime is announced in the journal',
  );
});

test('discoverRuntimeProvidersOnce announces a down runtime only once across re-scans', async () => {
  const session = sessionWithEvents();
  const config = [{ id: 'down', type: 'fake', available: false }];

  await discoverRuntimeProvidersOnce(session, { config });
  await discoverRuntimeProvidersOnce(session, { config });

  const logs = (session.agentEvents ?? []).filter((event) => event.type === 'runtime_log'
    && String(event.payload?.message ?? '').includes('unavailable'));
  assert.equal(logs.length, 1, 'the degradation is announced once, not on every re-scan');
});

test('a transient probe failure keeps the last-known capability set (a failed probe is not a lost agent)', async () => {
  const session = sessionWithEvents();
  const up = [{ id: 'gw', type: 'fake', capabilities: [{ name: 'agent.review', operations: ['run'] }] }];
  const down = [{ id: 'gw', type: 'fake', available: false }];

  await discoverRuntimeProvidersOnce(session, { config: up });
  assert.equal(session.runtimeProviderAgents.length, 1);

  // Network blip during a periodic re-scan: discovery returns nothing.
  await discoverRuntimeProvidersOnce(session, { config: down });
  assert.equal(session.runtimeProviderAgents.length, 1, 'the capability survives the blip');
  assert.equal(session.runtimeProviderAgents[0].agentInstanceId, 'gw::agent.review');

  const logs = (session.agentEvents ?? []).filter((event) => event.type === 'runtime_log'
    && String(event.payload?.message ?? '').includes('keeping'));
  assert.equal(logs.length, 1, 'the preservation is announced');

  // Recovery: a fresh answer is authoritative again.
  await discoverRuntimeProvidersOnce(session, { config: up });
  assert.equal(session.runtimeProviderAgents.length, 1);
});

test('a healthy runtime that answers is authoritative — its set replaces, never merges with, the last-known one', async () => {
  const session = sessionWithEvents();
  await discoverRuntimeProvidersOnce(session, {
    config: [{ id: 'gw', type: 'fake', capabilities: [{ name: 'agent.review', operations: ['run'] }] }],
  });
  assert.deepEqual(session.runtimeProviderAgents.map((a) => a.agentInstanceId), ['gw::agent.review']);

  await discoverRuntimeProvidersOnce(session, {
    config: [{ id: 'gw', type: 'fake', capabilities: [{ name: 'agent.consistency', operations: ['run'] }] }],
  });
  assert.deepEqual(
    session.runtimeProviderAgents.map((a) => a.agentInstanceId),
    ['gw::agent.consistency'],
    'the stale agent.review is gone, not kept alongside',
  );
});

test('GATEWAY_ENABLED inherits the disabled entry\'s declared capabilities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runtimes-'));
  try {
    writeFileSync(join(dir, 'agent-runtimes.json'), JSON.stringify({
      runtimes: [{
        id: 'deepagents',
        type: 'deepagents',
        endpoint: 'http://agent-runtime:7789',
        enabled: false,
        capabilities: [
          { name: 'agent.notify', operations: ['run'], defaultRequiresApproval: true },
        ],
      }],
    }));
    const config = loadAgentRuntimesConfig({ stateDir: dir, env: { GATEWAY_ENABLED: 'true' } });
    const implied = config.find((entry) => entry.type === 'deepagents');
    assert.ok(implied);
    assert.equal(implied.enabled, true);
    assert.equal(implied.endpoint, 'http://localhost:7789', 'the endpoint stays host-local');
    assert.deepEqual(implied.capabilities, [
      { name: 'agent.notify', operations: ['run'], defaultRequiresApproval: true },
    ], 'the shipped approval metadata is not discarded');
    assert.equal(config.filter((entry) => entry.type === 'deepagents').length, 1, 'no duplicate entry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('external runtime capabilities carry aliases through to the registry', async () => {
  const provider = createFakeRuntimeProvider({
    capabilities: [{ name: 'agent.review', operations: ['run'], aliases: ['audit', 'review', 'analyze'] }],
  });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);

  assert.deepEqual(agents[0].description.capabilities[0].aliases, ['audit', 'review', 'analyze']);
  assert.equal(agents[0].description.orchestration.canPlan, false);
  assert.equal(agents[0].description.orchestration.singleTaskOnly, true, 'external runtimes are executor-only single-task');
});

test('external runtime capabilities carry mutationClass and defaultRequiresApproval through', async () => {
  const provider = createFakeRuntimeProvider({
    capabilities: [
      { name: 'agent.research', operations: ['run'], mutationClass: 'ingest' },
      { name: 'agent.notify', operations: ['run'], defaultRequiresApproval: true },
    ],
  });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);

  const byName = new Map(
    agents.map((agent) => [agent.description.capabilities[0].id, agent.description.capabilities[0]]),
  );
  assert.equal(byName.get('agent.research').mutationClass, 'ingest');
  assert.equal(byName.get('agent.research').defaultRequiresApproval, undefined);
  assert.equal(byName.get('agent.notify').defaultRequiresApproval, true);
  assert.equal(byName.get('agent.notify').mutationClass, undefined);
});

test('external runtime capabilities carry aliasOperations through', async () => {
  const provider = createFakeRuntimeProvider({
    capabilities: [{ name: 'agent.plan', operations: ['plan', 'run'], aliasOperations: { plan: 'plan', apply: 'run' } }],
  });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);

  assert.deepEqual(agents[0].description.capabilities[0].aliasOperations, { plan: 'plan', apply: 'run' });
});

test('resolveObjective deterministically routes "audit" to agent.review via aliases (no LLM)', async () => {
  const provider = createFakeRuntimeProvider({
    capabilities: [{ name: 'agent.review', operations: ['run'], aliases: ['audit', 'review', 'analyze'] }],
  });
  const { agents } = await discoverRuntimeProviderAgents([{ id: 'deepagents', provider }]);
  const session = { runtimeProviderAgents: agents };

  const selection = await resolveObjective('audit la couverture conceptuelle', session);

  assert.equal(selection.capability, 'agent.review');
  assert.equal(selection.operation, 'run');
});
