import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyControlMessage } from './server.js';

const running = { running: true };

// A bare "yes" answers the runtime's own last prompt. Anything MORE than a
// bare yes is a request, and the rule used to be prefix-anchored only: every
// message merely STARTING on a yes was classified `observe` and answered with
// a status report, shadowing the modify_run and enqueue_run branches below it.
test('a bare confirmation during a run is a status check', async () => {
  for (const input of ['oui', 'OK', 'vas-y', "d'accord", 'yes.', 'entendu !']) {
    const result = await classifyControlMessage(input, running);
    assert.equal(result.kind, 'observe', `expected observe for ${JSON.stringify(input)}`);
  }
});

test('a plan change that merely opens on a yes reaches the model, not the status branch', async () => {
  const result = await classifyControlMessage(
    'oui, ajoute une étape de polish après le build',
    running,
    { llm: { complete: async () => 'plan_change' } },
  );
  assert.equal(result.kind, 'modify_run');
});

test('a new task that opens on a yes reaches the model classifier, not the status branch', async () => {
  const result = await classifyControlMessage("vas-y lance l'export", running, {
    llm: { complete: async () => 'action' },
  });
  assert.equal(result.kind, 'enqueue_run');
});

// The empty-chat "Curate the wiki" tile sends free-text prose. While a run was
// active, its "pages that disagree or repeat each other" matched the
// deterministic modify_run keyword "each" and the curation became an invisible
// plan patch instead of a queued run.
test('a curation objective during a run is queued, never an invisible plan patch', async () => {
  const objective =
    'Curate the wiki: find duplicate pages, pages that disagree or repeat each other, '
    + 'outdated or superseded pages, and claims with no cited source, then write the '
    + 'corrections on a dedicated branch.';
  const result = await classifyControlMessage(objective, running, {
    llm: { complete: async () => 'action' },
  });
  assert.equal(result.kind, 'enqueue_run');
});

test('a question about curation stays read-only', async () => {
  const result = await classifyControlMessage('explain how curation works', running, {
    llm: { complete: async () => 'question' },
  });
  assert.equal(result.kind, 'converse');
});

test('a genuine plan change is classified as modify_run by the model', async () => {
  const result = await classifyControlMessage('ajoute une étape de polish après le build', running, {
    llm: { complete: async () => 'plan_change' },
  });
  assert.equal(result.kind, 'modify_run');
});

// Measured 2026-09-25 (plan-demandes-pendant-run.md §2): keywords inside a
// sentence decided before the model, so questions typed during an ingest were
// answered with the run status, turned into patches of the running plan, or
// cancelled the run. No keyword inside a sentence decides any more.
test('a keyword inside a question never decides the triage', async () => {
  const asked = [];
  const llm = { complete: async ({ input }) => { asked.push(input); return 'question'; } };
  for (const question of [
    "montre-moi ce que dit le wiki sur l'option A",
    'explique la différence entre les options A et B',
    'cherche les pages qui parlent du plan de charge',
    'que se passe-t-il après la validation dans SISBA ?',
    "quand est-ce qu'on stop le support de CDPOM ?",
    'que dit le wiki sur la curation des données ?',
    "qu'est-ce qu'on fait ensuite dans le projet ?",
  ]) {
    const result = await classifyControlMessage(question, running, { llm });
    assert.equal(result.kind, 'converse', question);
  }
  assert.equal(asked.length, 7, 'every one of them reached the model');
});

test('the model categories map onto the control kinds', async () => {
  for (const [word, kind] of [
    ['question', 'converse'], ['status', 'observe'], ['action', 'enqueue_run'],
    ['plan_change', 'modify_run'], ['cancel', 'cancel'], ['Action.', 'enqueue_run'],
  ]) {
    const result = await classifyControlMessage('modifie la page option-a', running, {
      llm: { complete: async () => word },
    });
    assert.equal(result.kind, kind, word);
  }
});

test('only a whole-message command is decided without the model', async () => {
  const cases = [
    ['stop', 'cancel'], ['annule', 'cancel'], ['arrête tout !', 'cancel'], ['cancel the run', 'cancel'],
    ["annule l'ingestion", 'cancel'], ['status', 'observe'], ['où en est-on ?', 'observe'],
    ['logs', 'observe'], ['quel est le statut du run ?', 'observe'],
    ["mets en file l'export", 'enqueue_run'], ['lance le build après ce run', 'enqueue_run'],
  ];
  for (const [input, kind] of cases) {
    const result = await classifyControlMessage(input, running);
    assert.equal(result.kind, kind, input);
  }
});

test('without a model every other message is read-only conversation', async () => {
  for (const input of ['curate the wiki', 'modifie la page option-a', "quand est-ce qu'on stop le support ?"]) {
    const result = await classifyControlMessage(input, running);
    assert.equal(result.kind, 'converse', input);
  }
});
