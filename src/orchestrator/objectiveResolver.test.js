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

test('resolveObjective uses an unambiguously mentioned registry operation without asking the LLM', async () => {
  const session = sessionWithSelection({ capability: 'external-source.export', operation: 'export' });
  session.capabilityRegistry.snapshot = () => ({
    'knowledge.update@1': [sessionWithSelection({}).capabilityRegistry.snapshot()['knowledge.update@1'][0]],
    'external-source.export@1': [{
      agentInstanceId: 'cme-1',
      serverName: 'cme',
      capability: { id: 'external-source.export', version: '1', supportedOperations: ['export'] },
    }],
  });
  session.capabilityRegistry.providersFor = (capability) =>
    session.capabilityRegistry.snapshot()[`${capability}@1`] ?? [];
  session.llm.completeWithTools = async () => {
    throw new Error('the explicit operation must not depend on LLM selection');
  };

  const result = await resolveObjective("lance l'ingestion", session);
  assert.equal(result.capability, 'knowledge.update');
  assert.equal(result.operation, 'ingest');
  assert.equal(result.provider.agentInstanceId, 'production-1');
});

test('resolveObjective rejects invented capability and operation', async () => {
  await assert.rejects(
    resolveObjective('Traite tout', sessionWithSelection({ capability: 'ingest', operation: 'ingest_all_pending' })),
    /unknown capability "ingest"/,
  );
});
