import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capabilityCandidates,
  objectiveForResolution,
  resolveObjective,
  ObjectiveNotOrchestrableError,
} from './objectiveResolver.js';

function makeCapability(id, { operations = [], aliases = [], aliasOperations = {}, description = '' } = {}) {
  return { id, version: '1', description, supportedOperations: operations, aliases, aliasOperations };
}

function provider(agentInstanceId, capability) {
  return { agentInstanceId, serverName: agentInstanceId.split('-')[0], capability };
}

function sessionWith(providers, llmSelection = {}) {
  const snapshot = {};
  for (const entry of providers) {
    const key = `${entry.capability.id}@${entry.capability.version ?? '1'}`;
    (snapshot[key] ??= []).push(entry);
  }
  return {
    capabilityRegistry: {
      snapshot: () => snapshot,
      providersFor: (capability) => Object.entries(snapshot)
        .filter(([key]) => key === capability || key.startsWith(`${capability}@`))
        .flatMap(([, ps]) => ps),
    },
    llm: { completeWithTools: async () => ({ content: JSON.stringify(llmSelection) }) },
  };
}

const knowledge = makeCapability('knowledge.update', {
  operations: ['ingest', 'ingest_plan', 'ingest_apply'],
  aliases: ['ingest', 'ingestion'],
  description: 'Update knowledge from pending sources.',
});
const cme = makeCapability('external-source.export', {
  operations: ['export'],
  aliases: ['confluence', 'confluence export', 'source export'],
  description: 'Export configured Confluence sources.',
});
const publish = makeCapability('document.publish', {
  operations: ['export', 'polish'],
  aliases: ['publish', 'export deliverable'],
  description: 'Export or polish existing deliverables.',
});
const diagnose = makeCapability('workspace.diagnose', {
  operations: ['doctor'],
  aliases: ['diagnose', 'diagnostic', 'doctor'],
  description: 'Diagnose workspace configuration.',
});
const sendEmail = makeCapability('communication.send-email', {
  operations: ['send'],
  description: 'Send an email.',
});

test('capabilityCandidates exposes aliases from the closed live registry', () => {
  assert.deepEqual(capabilityCandidates(sessionWith([provider('production-1', knowledge)])), [{
    id: 'knowledge.update',
    description: 'Update knowledge from pending sources.',
    operations: ['ingest', 'ingest_apply', 'ingest_plan'],
    aliases: ['ingest', 'ingestion'],
    aliasOperations: {},
  }]);
});

test('resolveObjective selects and validates one real provider', async () => {
  const result = await resolveObjective('Ingère tous les fichiers en attente', sessionWith(
    [provider('production-1', knowledge)],
    { capability: 'knowledge.update', operation: 'ingest' },
  ));
  assert.equal(result.capability, 'knowledge.update');
  assert.equal(result.operation, 'ingest');
  assert.equal(result.provider.agentInstanceId, 'production-1');
});

test('resolveObjective disambiguates "export" of a Confluence source via alias, without the LLM', async () => {
  const session = sessionWith([
    provider('production-1', knowledge),
    provider('production-2', publish),
    provider('cme-1', cme),
  ]);
  session.llm.completeWithTools = async () => {
    throw new Error('the explicit alias must not depend on LLM selection');
  };
  const result = await resolveObjective('Export the requested Confluence source', session);
  assert.equal(result.capability, 'external-source.export');
  assert.equal(result.operation, 'export');
  assert.equal(result.provider.agentInstanceId, 'cme-1');
});

test('resolveObjective resolves the ingest step of wiki-sync deterministically despite notification and guardrails', async () => {
  const session = sessionWith([
    provider('production-1', knowledge),
    provider('production-2', publish),
    provider('cme-1', cme),
    provider('connectors-1', sendEmail),
  ]);
  session.llm.completeWithTools = async () => {
    throw new Error('the aliased intention must not depend on LLM selection');
  };
  const objective = 'Ingest the newly exported Markdown into the wiki. Do not build or publish deliverables. If a messaging connector and a notification recipient are available, send a short best-effort summary; otherwise skip notification silently.';
  const result = await resolveObjective(objective, session);
  assert.equal(result.capability, 'knowledge.update');
  assert.equal(result.operation, 'ingest');
});

test('resolveObjective resolves diagnose via alias despite the notification "send"', async () => {
  const session = sessionWith([
    provider('production-1', diagnose),
    provider('connectors-1', sendEmail),
  ]);
  session.llm.completeWithTools = async () => {
    throw new Error('the alias must resolve without the LLM');
  };
  const objective = 'Run a complete read-only diagnostic. If a messaging connector is available, send a short summary; otherwise skip notification silently.';
  const result = await resolveObjective(objective, session);
  assert.equal(result.capability, 'workspace.diagnose');
  assert.equal(result.operation, 'doctor');
});

const concepts = makeCapability('knowledge.concepts', {
  operations: ['concepts', 'reclassify-concepts'],
  aliases: ['concept grid', 'reclassify concepts', 'file unclassified concepts'],
  aliasOperations: {
    'concept grid': 'concepts',
    'reclassify concepts': 'reclassify-concepts',
    'file unclassified concepts': 'reclassify-concepts',
  },
  description: 'Synthesize the concept grid or file unclassified pages into it.',
});

/*
 Regression: with two operations, [...new Set(supportedOperations)].sort()
 alphabetizes to ["concepts", "reclassify-concepts"], so a naive alias hit
 defaulting to operations[0] would ALWAYS resolve to "concepts" — the
 destructive grid rebuild — even for aliases explicitly authored to reach the
 safe "reclassify-concepts" operation. aliasOperations must be consulted
 first.
*/
test('resolveObjective routes "reclassify concepts" to reclassify-concepts, not operations[0]', async () => {
  const session = sessionWith([provider('production-1', concepts)]);
  session.llm.completeWithTools = async () => {
    throw new Error('the aliased operation must not depend on LLM selection');
  };
  const result = await resolveObjective('Please reclassify concepts in the workspace', session);
  assert.equal(result.capability, 'knowledge.concepts');
  assert.equal(result.operation, 'reclassify-concepts');
});

test('resolveObjective routes "file unclassified concepts" to reclassify-concepts', async () => {
  const session = sessionWith([provider('production-1', concepts)]);
  session.llm.completeWithTools = async () => {
    throw new Error('the aliased operation must not depend on LLM selection');
  };
  const result = await resolveObjective('File unclassified concepts into the grid', session);
  assert.equal(result.capability, 'knowledge.concepts');
  assert.equal(result.operation, 'reclassify-concepts');
});

test('resolveObjective routes "concept grid" to the concepts operation', async () => {
  const session = sessionWith([provider('production-1', concepts)]);
  session.llm.completeWithTools = async () => {
    throw new Error('the aliased operation must not depend on LLM selection');
  };
  const result = await resolveObjective('Rebuild the concept grid', session);
  assert.equal(result.capability, 'knowledge.concepts');
  assert.equal(result.operation, 'concepts');
});

test('resolveObjective falls back to operations[0] when a matched alias has no aliasOperations entry', async () => {
  // A capability that never declares aliasOperations (every existing
  // single-operation capability) must keep working exactly as before.
  const session = sessionWith(
    [provider('production-1', diagnose)],
    { capability: 'workspace.diagnose', operation: 'doctor' },
  );
  const result = await resolveObjective('diagnose the workspace', session);
  assert.equal(result.capability, 'workspace.diagnose');
  assert.equal(result.operation, 'doctor');
});

test('objectiveForResolution strips notification and negative guardrails', () => {
  const clean = objectiveForResolution(
    'Ingest files. Do not build or publish deliverables. If a messaging connector is available, send a summary; otherwise skip notification silently.',
  );
  assert.ok(!/\bsend\b/.test(clean), 'notification "send" must be stripped');
  assert.ok(!/\bbuild\b/.test(clean), 'guardrail "build" must be stripped');
  assert.ok(!/\bnotification\b/.test(clean), 'the word "notification" must be stripped');
  assert.match(clean, /Ingest files/);
});

test('resolveObjective never binds the generic word "plan" to ingest_plan', async () => {
  const session = sessionWith(
    [provider('production-1', knowledge)],
    { capability: null, reason: 'no capability' },
  );
  await assert.rejects(
    resolveObjective('Preserve the delivery capability internal execution plan', session),
    (err) => {
      assert.equal(err.name, 'ObjectiveNotOrchestrableError');
      return true;
    },
  );
});

test('resolveObjective never binds the past participle "exported" to an export operation', async () => {
  const session = sessionWith([
    provider('production-1', publish),
    provider('cme-1', cme),
  ]);
  session.llm.completeWithTools = async () => ({ content: JSON.stringify({ capability: null, reason: 'no capability' }) });
  // "newly exported Markdown" describes state, not the action to run.
  await assert.rejects(
    resolveObjective('Review the newly exported Markdown', session),
    (err) => {
      assert.equal(err.name, 'ObjectiveNotOrchestrableError');
      return true;
    },
  );
});

test('resolveObjective declines an objective no listed capability covers', async () => {
  const session = sessionWith(
    [provider('production-1', knowledge)],
    { capability: null, reason: 'Gmail authorization is not an orchestrable capability.' },
  );
  await assert.rejects(
    resolveObjective("cree l'auth pour le gmail", session),
    (err) => {
      assert.equal(err.name, 'ObjectiveNotOrchestrableError');
      assert.match(err.message, /No connected agent can do that\./);
      assert.match(err.message, /Available capabilities: knowledge\.update\./);
      assert.deepEqual(err.candidates, ['knowledge.update']);
      return true;
    },
  );
});

test('resolveObjective treats a malformed selection as a resolution defect, not a decline', async () => {
  await assert.rejects(
    resolveObjective('Traite tout', sessionWith([provider('production-1', knowledge)], { reason: 'missing capability' })),
    (err) => {
      assert.notEqual(err.name, 'ObjectiveNotOrchestrableError');
      assert.match(err.message, /unknown capability/);
      return true;
    },
  );
});

test('resolveObjective rejects invented capability and operation', async () => {
  await assert.rejects(
    resolveObjective('Traite tout', sessionWith([provider('production-1', knowledge)], { capability: 'ingest', operation: 'ingest_all_pending' })),
    /unknown capability "ingest"/,
  );
});
