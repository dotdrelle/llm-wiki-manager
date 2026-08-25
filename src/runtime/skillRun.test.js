import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPublicSkillInvocation, generateSkillAcknowledgment, runSkillChain, validateNamedSkillArguments } from './skillRun.js';

const skill = { name: 'deliver', params: ['deliverable', 'polish'], body: 'Deliver the requested output.' };

test('named skill arguments preserve spaces and fill omitted declarations with empty strings', () => {
  const args = validateNamedSkillArguments(skill, { deliverable: 'Quarterly report' });
  assert.equal(Object.getPrototypeOf(args), null);
  assert.deepEqual({ ...args }, { deliverable: 'Quarterly report', polish: '' });
});

test('named skill arguments reject undeclared, non-string, and oversized values', () => {
  assert.throws(() => validateNamedSkillArguments(skill, { target: 'x' }), { code: 'skill_arguments_invalid' });
  assert.throws(() => validateNamedSkillArguments(skill, { deliverable: 42 }), { code: 'skill_arguments_invalid' });
  assert.throws(() => validateNamedSkillArguments(skill, { deliverable: 'x'.repeat(2_001) }), { code: 'skill_arguments_invalid' });
});

test('runSkillChain enqueues named arguments without exposing a skill body field', async () => {
  const queued = [];
  const result = await runSkillChain({ session: {} }, skill, {
    args: { deliverable: 'Quarterly report' },
    enqueueControlRequest(_context, input, metadata) {
      const item = { id: `item-${queued.length}`, input, status: 'queued', ...metadata };
      queued.push(item);
      return item;
    },
    drainControlQueue() {},
  });
  assert.equal(result.objectives, 1);
  assert.match(queued[0].input, /deliverable: Quarterly report/);
  assert.equal(queued[0].publicInput, '/deliver deliverable="Quarterly report"');
  assert.equal(queued[0].skillExecution, 'orchestrated');
  assert.equal('body' in queued[0], false);
});

test('public skill invocation contains arguments but never compiled objective prose', () => {
  const rendered = formatPublicSkillInvocation('deliver', { deliverable: 'Quarterly report', polish: '' });
  assert.equal(rendered, '/deliver deliverable="Quarterly report"');
  assert.doesNotMatch(rendered, /Deliver the requested output/);
});

/*
 La pile voyage avec l'élément, sinon elle n'existe plus quand il démarre.

 Elle vivait sur la session le temps d'un run, restaurée par son `finally`. Une
 compétence imbriquée n'étant pas exécutée en ligne mais MISE EN FILE, son run
 démarrait après ce nettoyage et lisait une pile vide : la garde n'attrapait que
 la réinvocation d'une compétence dans son propre run, et laissait passer A→B→A.
*/
test('runSkillChain stamps every queued item with the ancestor stack', async () => {
  const queued = [];
  await runSkillChain({ session: {} }, skill, {
    args: {},
    skillStack: ['pipeline', 'wiki-sync'],
    enqueueControlRequest(_context, input, metadata) {
      const item = { id: `item-${queued.length}`, input, ...metadata };
      queued.push(item);
      return item;
    },
    drainControlQueue() {},
  });

  assert.ok(queued.length > 0);
  for (const item of queued) {
    // La compétence lancée est empilée ici, une seule fois, au seul endroit qui
    // sait laquelle a réellement été résolue.
    assert.deepEqual(item.skillStack, ['pipeline', 'wiki-sync', 'deliver']);
  }
});

test('runSkillChain starts a fresh stack for a top-level invocation', async () => {
  const queued = [];
  await runSkillChain({ session: {} }, skill, {
    args: {},
    enqueueControlRequest(_context, input, metadata) {
      queued.push(metadata);
      return { id: 'item-0', input, ...metadata };
    },
    drainControlQueue() {},
  });

  assert.deepEqual(queued[0].skillStack, ['deliver']);
});

test('generateSkillAcknowledgment asks Donna in the session language and echoes the invocation', async () => {
  const calls = [];
  const session = {
    language: 'es',
    llm: { complete: async (request) => { calls.push(request); return 'Lanzado /deliver deliverable="Informe" — 1 paso en cola.'; } },
  };
  const reply = await generateSkillAcknowledgment(session, { publicInput: '/deliver deliverable="Informe"', objectives: 1 });
  assert.equal(reply, 'Lanzado /deliver deliverable="Informe" — 1 paso en cola.');
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /es/);
  assert.match(calls[0].input, /\/deliver deliverable="Informe"/);
});

test('generateSkillAcknowledgment degrades to a neutral message without an LLM client', async () => {
  const reply = await generateSkillAcknowledgment({ language: 'fr' }, { publicInput: '/wiki-ingest docs', objectives: 2 });
  assert.equal(reply, 'Started /wiki-ingest docs — 2 step(s) in progress.');
});

test('generateSkillAcknowledgment falls back when the LLM call fails', async () => {
  const session = { language: 'en', llm: { complete: async () => { throw new Error('down'); } } };
  const reply = await generateSkillAcknowledgment(session, { publicInput: '/deliver', objectives: 1 });
  assert.equal(reply, 'Started /deliver — 1 step(s) in progress.');
});

test('generateSkillAcknowledgment announces an LLM failure instead of degrading silently', async () => {
  // A degradation must announce itself: falling back to the neutral message
  // with no trace anywhere makes "LLM unconfigured" (expected) and "LLM
  // failing every call" (a real problem) look identical in the UI.
  const session = { language: 'en', llm: { complete: async () => { throw new Error('provider timeout'); } } };
  await generateSkillAcknowledgment(session, { publicInput: '/deliver', objectives: 1 });
  const runtimeLogs = (session.agentEvents ?? []).filter((event) => event.type === 'runtime_log');
  assert.equal(runtimeLogs.length, 1);
  assert.match(runtimeLogs[0].payload.detail ?? runtimeLogs[0].payload.message, /provider timeout/);
});
