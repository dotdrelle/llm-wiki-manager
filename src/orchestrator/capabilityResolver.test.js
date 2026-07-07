import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityUnavailableError, resolve } from './capabilityResolver.js';

function provider(agentInstanceId, capabilityId = 'knowledge.update', {
  contractVersion = '1',
  health = 'available',
  version = '1',
  estimatedCost = null,
  history = null,
  available = true,
} = {}) {
  return {
    agentInstanceId,
    health,
    available,
    history,
    capability: {
      id: capabilityId,
      version,
      description: capabilityId,
      inputSchema: {},
      outputSchema: {},
      supportedOperations: ['run'],
      ...(estimatedCost ? { estimatedCost } : {}),
    },
    description: {
      contractVersion,
      agentType: agentInstanceId.split('-')[0],
      agentInstanceId,
      displayName: agentInstanceId,
      capabilities: [],
    },
  };
}

function registry(providers, { compatibleVersions = ['1'] } = {}) {
  return {
    providersFor(capability) {
      const id = String(capability).split('@')[0];
      return providers.filter((item) => item.capability.id === id);
    },
    isCompatible(contractVersion) {
      return compatibleVersions.includes(String(contractVersion));
    },
  };
}

test('capabilityResolver rejects missing capability without falling back to a tool', () => {
  assert.throws(
    () => resolve('document.publish', { registry: registry([]) }),
    (error) => error instanceof CapabilityUnavailableError && error.reason === 'capability_not_found',
  );
});

test('capabilityResolver rejects when workspace allowedAgents excludes every provider', () => {
  assert.throws(
    () => resolve('knowledge.update', {
      registry: registry([provider('production-main')]),
      workspaceConfig: {
        capabilityRouting: {
          'knowledge.update': { allowedAgents: ['documents-main'] },
        },
      },
    }),
    (error) => error instanceof CapabilityUnavailableError && error.reason === 'agent_not_allowed',
  );
});

test('capabilityResolver chooses preferred healthy provider', () => {
  const result = resolve('knowledge.update', {
    registry: registry([provider('production-main'), provider('production-secondary')]),
    workspaceConfig: {
      capabilityRouting: {
        'knowledge.update': { preferredAgents: ['production-secondary'] },
      },
    },
  });

  assert.deepEqual(result, { agentInstanceId: 'production-secondary' });
});

test('capabilityResolver uses only configured fallback when preferred is unavailable', () => {
  const result = resolve('knowledge.update', {
    registry: registry([
      provider('production-main', 'knowledge.update', { health: 'unavailable' }),
      provider('production-fallback'),
      provider('production-other'),
    ]),
    workspaceConfig: {
      capabilityRouting: {
        'knowledge.update': {
          preferredAgents: ['production-main'],
          fallbackAgents: ['production-fallback'],
        },
      },
    },
  });

  assert.deepEqual(result, { agentInstanceId: 'production-fallback' });
});

test('capabilityResolver does not fallback to an unconfigured provider when preferred is unavailable', () => {
  assert.throws(
    () => resolve('knowledge.update', {
      registry: registry([
        provider('production-main', 'knowledge.update', { health: 'unavailable' }),
        provider('production-other'),
      ]),
      workspaceConfig: {
        capabilityRouting: {
          'knowledge.update': { preferredAgents: ['production-main'] },
        },
      },
    }),
    (error) => error instanceof CapabilityUnavailableError && error.reason === 'preferred_agent_unavailable',
  );
});

test('capabilityResolver rejects incompatible contract versions', () => {
  assert.throws(
    () => resolve('knowledge.update', {
      registry: registry([provider('future-agent', 'knowledge.update', { contractVersion: '99' })]),
    }),
    (error) => error instanceof CapabilityUnavailableError && error.reason === 'contract_incompatible',
  );
});
