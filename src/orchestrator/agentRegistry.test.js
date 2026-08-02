import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRegistry } from './agentRegistry.js';

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
