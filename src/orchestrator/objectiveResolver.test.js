import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityCandidates, resolveObjective } from './objectiveResolver.js';

function sessionWithSelection(selection) {
  const provider = {
    agentInstanceId: 'production-1',
    serverName: 'production',
    capability: {
      id: 'knowledge.update',
      version: '1',
      description: 'Update knowledge from pending sources.',
      supportedOperations: ['ingest'],
    },
  };
  return {
    capabilityRegistry: {
      snapshot: () => ({ 'knowledge.update@1': [provider] }),
      providersFor: () => [provider],
    },
    llm: {
      completeWithTools: async () => ({ content: JSON.stringify(selection) }),
    },
  };
}

test('capabilityCandidates exposes only the closed live registry', () => {
  assert.deepEqual(capabilityCandidates(sessionWithSelection({})), [{
    id: 'knowledge.update',
    description: 'Update knowledge from pending sources.',
    operations: ['ingest'],
  }]);
});

test('resolveObjective selects and validates one real provider', async () => {
  const result = await resolveObjective('Ingère tous les fichiers en attente', sessionWithSelection({
    capability: 'knowledge.update',
    operation: 'ingest',
  }));
  assert.equal(result.capability, 'knowledge.update');
  assert.equal(result.operation, 'ingest');
  assert.equal(result.provider.agentInstanceId, 'production-1');
});

test('resolveObjective rejects invented capability and operation', async () => {
  await assert.rejects(
    resolveObjective('Ingère tout', sessionWithSelection({ capability: 'ingest', operation: 'ingest_all_pending' })),
    /unknown capability "ingest"/,
  );
});
