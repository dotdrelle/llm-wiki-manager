import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRegistry, markPersistedAgentsStale } from './agentRegistry.js';
import { createCapabilityRegistry } from './capabilityRegistry.js';

function description({ agentInstanceId = 'production-main', health = 'available', contractVersion = '1' } = {}) {
  return {
    contractVersion,
    agentType: 'production',
    agentInstanceId,
    displayName: 'Production',
    capabilities: [{
      id: 'knowledge.update',
      version: '1',
      description: 'Update wiki knowledge',
      inputSchema: {},
      outputSchema: {},
      supportedOperations: ['ingest'],
      defaultRequiresApproval: true,
    }],
    orchestration: {
      canPlan: true,
      canExpandPlan: false,
      canExecute: true,
      canCancel: true,
      canResume: false,
      supportsIdempotency: false,
      supportsParallelWorkers: true,
    },
    limits: {
      recommendedConcurrency: 2,
      maxConcurrency: 4,
    },
    health: { status: health },
  };
}

test('agentRegistry discovers connected contract agents through agent_describe', async () => {
  const events = [];
  const session = {
    workspace: 'docs',
    mcp: {
      production: {
        status: 'connected',
        tools: [{ name: 'production__agent_describe' }],
      },
    },
    _onAgentEvent: (event) => events.push(event),
  };
  const registry = createAgentRegistry({
    callTool: async (_mcp, server, tool) => {
      assert.equal(server, 'production');
      assert.equal(tool, 'production__agent_describe');
      return { content: [{ type: 'text', text: JSON.stringify(description()) }] };
    },
  });

  const agents = await registry.discover(session);

  assert.equal(agents.length, 1);
  assert.equal(agents[0].agentInstanceId, 'production-main');
  assert.equal(agents[0].legacy, false);
  assert.equal(agents[0].health, 'available');
  assert.equal(events[0].type, 'agent.registered');
  assert.equal(events[0].payload.agent.agentInstanceId, 'production-main');
});

test('agentRegistry records legacy visible agents when no contract tool exists', async () => {
  const session = {
    mcp: {
      cme: {
        status: 'connected',
        tools: [{ name: 'cme_export_run' }],
      },
    },
  };
  const registry = createAgentRegistry({
    callTool: async () => assert.fail('agent_describe should not be called'),
  });

  const [agent] = await registry.discover(session);

  assert.equal(agent.agentInstanceId, 'cme-legacy');
  assert.equal(agent.legacy, true);
  assert.equal(agent.orchestrable, false);
  assert.equal(agent.health, 'available');
});

test('agentRegistry removes a server that disappeared during MCP refresh', async () => {
  const events = [];
  const session = {
    mcp: {
      cme: { status: 'connected', tools: [{ name: 'cme_status' }] },
      exa: { status: 'connected', tools: [{ name: 'web_search_exa' }] },
    },
    _onAgentEvent: (event) => events.push(event),
  };
  const registry = createAgentRegistry({ callTool: async () => assert.fail('no contract tool expected') });
  await registry.discover(session);
  assert.deepEqual(registry.snapshot().map((agent) => agent.serverName), ['cme', 'exa']);

  delete session.mcp.cme;
  await registry.discover(session);

  assert.deepEqual(registry.snapshot().map((agent) => agent.serverName), ['exa']);
  assert.ok(events.some((event) => event.type === 'agent.unregistered' && event.payload.serverName === 'cme'));
});

test('agentRegistry marks unavailable boot agents and emits health changes on re-scan', async () => {
  const events = [];
  let health = 'unavailable';
  const session = {
    mcp: {
      production: {
        status: 'connected',
        tools: [{ name: 'agent_describe' }],
      },
    },
    _onAgentEvent: (event) => events.push(event),
  };
  const registry = createAgentRegistry({
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(description({ health })) }] }),
  });

  await registry.discover(session);
  health = 'available';
  await registry.discover(session);

  assert.equal(events[0].type, 'agent.registered');
  assert.equal(events[0].payload.agent.health, 'unavailable');
  assert.equal(events[1].type, 'agent.health_changed');
  assert.equal(events[1].payload.previousHealth, 'unavailable');
  assert.equal(events[1].payload.health, 'available');
  assert.equal(registry.snapshot()[0].health, 'available');
});

test('a failed re-discovery keeps the orchestrator agent, never erases its capabilities', async () => {
  /*
   Boot order: the runtime starts before its containers. The first scan sees the
   production endpoint "unavailable" and would register a legacy placeholder —
   and the old code replaced the orchestrator agent with it, silently dropping
   every capability until a LATER successful discovery. The agent must survive a
   transient probe failure, because its capabilities did not change.
  */
  const events = [];
  const session = {
    workspace: 'acpi',
    mcp: {
      production: { status: 'connected', tools: [{ name: 'agent_describe' }] },
    },
    _onAgentEvent: (event) => events.push(event),
  };
  const registry = createAgentRegistry({
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(description()) }] }),
  });

  await registry.discover(session);
  assert.equal(registry.snapshot()[0].agentInstanceId, 'production-main');

  // The endpoint goes down: discovery now falls back to a legacy placeholder.
  session.mcp.production.status = 'unavailable';
  await registry.discover(session);

  const [agent] = registry.snapshot();
  assert.equal(agent.agentInstanceId, 'production-main');
  assert.equal(agent.legacy, false);
  assert.equal(agent.description.capabilities.length, 1);
  // And it is still routable: the capability was not erased.
  const capability = createCapabilityRegistry({ agents: registry.snapshot() });
  assert.equal(capability.providersFor('knowledge.update').length, 1);

  /*
   Preserving must not be silent.

   Every defect this registry produced was invisible, and that is what turned a
   boot-order race into a debugging session: the capability vanished with no
   event, and the only report came much later, from the resolver, as "no agent
   provides X". A probe that failed is a fact, and it belongs where the shell
   and the panels already read.
  */
  const kept = events.find((event) => event.type === 'runtime_log'
    && String(event.payload?.message ?? '').includes('agent-registry:'));
  assert.ok(kept, 'a preserved agent must leave a runtime log');
  assert.match(String(kept.payload.message), /did not answer agent_describe/);
  assert.match(String(kept.payload.message), /knowledge\.update/);
});

test('a failed re-discovery keeps a degraded orchestrator agent too', async () => {
  // Same protection, but when the agent was discovered healthy then the probe
  // throws (endpoint "connected" but agent_describe fails mid-flight).
  const session = {
    mcp: { production: { status: 'connected', tools: [{ name: 'agent_describe' }] } },
  };
  let fail = false;
  const registry = createAgentRegistry({
    callTool: async () => {
      if (fail) throw new Error('agent_describe timeout');
      return { content: [{ type: 'text', text: JSON.stringify(description()) }] };
    },
  });

  await registry.discover(session);
  fail = true;
  await registry.discover(session);

  const [agent] = registry.snapshot();
  assert.equal(agent.agentInstanceId, 'production-main');
  assert.equal(agent.legacy, false);
  assert.equal(agent.description.capabilities.length, 1);
});

test('discovery sends the workspace only to agents whose schema declares it', async () => {
  const seen = {};
  const registry = createAgentRegistry({
    callTool: async (_mcp, server, _tool, args) => {
      seen[server] = args;
      return { content: [{ type: 'text', text: JSON.stringify(description()) }] };
    },
  });

  await registry.discover({
    workspace: 'acpi',
    mcp: {
      // Declares workspace: gets it, and can scope its vocabulary.
      cme: {
        status: 'connected',
        tools: [{
          name: 'agent_describe',
          inputSchema: { type: 'object', properties: { workspace: { type: 'string' } }, additionalProperties: false },
        }],
      },
      // Strict schema without workspace: sending it would be REJECTED, the
      // agent would drop out of the registry, and its capabilities would
      // silently vanish from objective resolution.
      production: {
        status: 'connected',
        tools: [{
          name: 'agent_describe',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      },
      // Open schema: tolerant, so the workspace is worth sending.
      connectors: {
        status: 'connected',
        tools: [{ name: 'agent_describe', inputSchema: { type: 'object', properties: {} } }],
      },
      // No schema published at all: assume nothing.
      legacyish: {
        status: 'connected',
        tools: [{ name: 'agent_describe' }],
      },
    },
  });

  assert.deepEqual(seen.cme, { workspace: 'acpi' });
  assert.deepEqual(seen.production, {});
  assert.deepEqual(seen.connectors, { workspace: 'acpi' });
  assert.deepEqual(seen.legacyish, {});
});

test('discovery sends no workspace argument when no workspace is active', async () => {
  const seen = [];
  const registry = createAgentRegistry({
    callTool: async (_mcp, _server, _tool, args) => {
      seen.push(args);
      return { content: [{ type: 'text', text: JSON.stringify(description()) }] };
    },
  });

  await registry.discover({
    mcp: {
      cme: {
        status: 'connected',
        tools: [{
          name: 'agent_describe',
          inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
        }],
      },
    },
  });

  assert.deepEqual(seen, [{}]);
});

/*
 Cas observé le 2026-08-04 : après redémarrage du runtime, `cme-main` était
 toujours présenté `available` alors que son endpoint n'existait plus. La
 relecture du journal restitue la santé qu'un agent avait AU MOMENT où
 l'événement a été écrit — la persistance dit ce qui a existé, pas ce qui
 répond maintenant.
*/
test('un agent restauré depuis le journal n’est pas déclaré disponible', () => {
  const session = {
    agents: [
      { agentInstanceId: 'cme-main', serverName: 'cme', health: 'available', description: { contractVersion: '1', capabilities: [{ id: 'external-source.export', version: '1' }] } },
      { agentInstanceId: 'production-main', serverName: 'production', health: 'available', description: { contractVersion: '1', capabilities: [{ id: 'knowledge.update', version: '1' }] } },
    ],
  };

  markPersistedAgentsStale(session);

  for (const agent of session.agents) {
    assert.equal(agent.health, 'unknown');
    assert.equal(agent.stale, true);
    // Ce qu'on savait avant l'arrêt reste lisible, sans jamais servir au routage.
    assert.equal(agent.healthBeforeRestart, 'available');
  }
  // Et surtout : plus aucun fournisseur sélectionnable tant que le scan n'a pas
  // confirmé. C'est la seule chose qui empêche une tâche de partir vers un
  // agent absent.
  const registry = createCapabilityRegistry({ agents: session.agents });
  assert.deepEqual(registry.providersFor('external-source.export'), []);
  assert.deepEqual(registry.providersFor('knowledge.update'), []);
});

test('markPersistedAgentsStale invalide aussi l’instantané routable', () => {
  /*
   J'avais d'abord épargné `agentRegistrySnapshot`, au motif qu'il pouvait
   porter un scan vivant. Inversion : à l'hydratation aucun scan n'a eu lieu,
   l'ordre étant hydrate → invalidate → discover. L'épargner laissait
   `cme-main` routable avec son endpoint éteint — constaté à chaud.
  */
  const session = {
    agents: [{ agentInstanceId: 'cme-main', health: 'available' }],
    agentRegistrySnapshot: [{ agentInstanceId: 'cme-main', health: 'available' }],
  };

  markPersistedAgentsStale(session);

  assert.equal(session.agents[0].health, 'unknown');
  assert.equal(session.agentRegistrySnapshot[0].health, 'unknown');
});

test('un agent redevient sélectionnable après un agent_describe réussi', async () => {
  const session = {
    workspace: 'juno',
    agentEvents: [],
    agents: [{ agentInstanceId: 'production-main', serverName: 'production', health: 'available', description: { contractVersion: '1', capabilities: [{ id: 'knowledge.update', version: '1' }] } }],
    mcp: {
      production: { status: 'connected', tools: [{ name: 'agent_describe' }] },
    },
  };
  markPersistedAgentsStale(session);
  assert.deepEqual(createCapabilityRegistry({ agents: session.agents }).providersFor('knowledge.update'), []);

  const registry = createAgentRegistry({
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(description()) }] }),
  });
  await registry.discover(session);

  // La reconnexion suffit : aucune intervention, aucun redémarrage.
  assert.equal(session.agentRegistrySnapshot[0].health, 'available');
  assert.equal(
    createCapabilityRegistry({ agents: session.agentRegistrySnapshot }).providersFor('knowledge.update').length,
    1,
  );
});
