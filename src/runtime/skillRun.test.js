import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPublicSkillInvocation, runSkillChain, validateNamedSkillArguments } from './skillRun.js';

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
