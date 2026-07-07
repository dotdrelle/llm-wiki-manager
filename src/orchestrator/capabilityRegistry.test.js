import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityRegistry } from './capabilityRegistry.js';

function agent(agentInstanceId, capabilityId, { contractVersion = '1', health = 'available', version = '1' } = {}) {
  return {
    agentInstanceId,
    health,
    description: {
      contractVersion,
      agentType: agentInstanceId.split('-')[0],
      agentInstanceId,
      displayName: agentInstanceId,
      capabilities: [{
        id: capabilityId,
        version,
        description: capabilityId,
        inputSchema: {},
        outputSchema: {},
        supportedOperations: ['run'],
      }],
    },
  };
}

test('capabilityRegistry indexes two agents for the same capability', () => {
  const registry = createCapabilityRegistry({
    agents: [
      agent('production-main', 'knowledge.update'),
      agent('production-secondary', 'knowledge.update'),
    ],
  });

  assert.deepEqual(
    registry.providersFor('knowledge.update').map((provider) => provider.agentInstanceId),
    ['production-main', 'production-secondary'],
  );
  assert.deepEqual(
    registry.providersFor('knowledge.update@1').map((provider) => provider.agentInstanceId),
    ['production-main', 'production-secondary'],
  );
});

test('capabilityRegistry excludes incompatible contract versions and unavailable agents', () => {
  const registry = createCapabilityRegistry({
    agents: [
      agent('compatible', 'document.build'),
      agent('future', 'document.build', { contractVersion: '99' }),
      agent('down', 'document.build', { health: 'unavailable' }),
    ],
  });

  assert.equal(registry.isCompatible('1'), true);
  assert.equal(registry.isCompatible('99'), false);
  assert.deepEqual(
    registry.providersFor('document.build').map((provider) => provider.agentInstanceId),
    ['compatible'],
  );
});
