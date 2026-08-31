import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRuntimeControlTool } from './graph.js';

/*
 Récursion observée en headless : `wiki-ingest` se réinvoquait au lieu de
 lancer la production, quatre fois avant interruption manuelle.

 La cause n'est pas le modèle. Le corps d'une compétence est compilé en
 intentions MÉTIER, et une intention ressemble forcément à la description de la
 compétence dont elle sort — « ingérer les fichiers en attente » est à la fois
 l'objectif de /wiki-ingest et sa raison d'être. Le sélecteur la reconnaissait
 donc légitimement. Ce qui manquait, c'est que le run ne savait pas d'où il
 venait : `chainId` et `skillName` s'arrêtaient à l'item de contrôle.
*/

function session(skillStack, ran = []) {
  return {
    // La garde d'entrée exige une URL de runtime ; le chemin run_skill passe
    // ensuite par _runSkillWithinRun sans jamais l'appeler.
    runtime: { url: 'http://runtime.invalid' },
    _skillStack: skillStack,
    _runSkillWithinRun: async (name) => { ran.push(name); return { ok: true, ran: name }; },
  };
}

const call = (state, skillName) =>
  handleRuntimeControlTool(state, 'run_skill', { skillName, _userInput: skillName })
    .then((raw) => JSON.parse(raw));

test('refuse de relancer une compétence déjà dans la pile', async () => {
  const result = await call(session(['wiki-ingest']), 'wiki-ingest');

  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.code, 'skill_recursion_blocked');
  // Le diagnostic doit dire quoi faire à la place, sinon le modèle réessaie
  // avec une autre formulation du même appel.
  assert.match(result.message, /execute its objective directly/i);
});

test('ignore la casse : le nom est le même concept', async () => {
  const result = await call(session(['wiki-ingest']), 'Wiki-Ingest');

  assert.equal(result.code, 'skill_recursion_blocked');
});

test('détecte un cycle indirect, pas seulement l’auto-appel', async () => {
  // a → b → a : chacun des deux appels est légitime pris isolément.
  const result = await call(session(['wiki-sync', 'wiki-ingest']), 'wiki-sync');

  assert.equal(result.code, 'skill_recursion_blocked');
});

test('laisse passer une composition sans cycle', async () => {
  // Le refus porte sur les cycles, pas sur la composition : une compétence a
  // le droit d'en appeler une autre.
  const result = await call(session(['wiki-sync']), 'deliver');

  assert.equal(result.ok, true);
  assert.equal(result.ran, 'deliver');
});

test('laisse passer une invocation hors de toute chaîne', async () => {
  const result = await call(session(undefined), 'wiki-ingest');

  assert.equal(result.ok, true);
});

/*
 `/new-template` observé en conditions réelles : la compétence se rappelait
 elle-même, le run finissait `done`, et rien n'avait été créé. Les tests
 ci-dessus vérifiaient le code de refus ; celui-ci vérifie qu'AUCUN travail
 n'est lancé — c'est ce qui distingue un refus d'un simple avertissement.
*/
test('un refus n’exécute rien du tout', async () => {
  const ran = [];
  const result = await handleRuntimeControlTool(
    session(['new-template'], ran),
    'run_skill',
    { skillName: 'new-template', _userInput: 'crée un modèle de présentation' },
  ).then((raw) => JSON.parse(raw));

  assert.equal(result.code, 'skill_recursion_blocked');
  assert.deepEqual(ran, [], 'aucun run imbriqué ne doit démarrer');
  // La pile revient au modèle : sans elle il ne peut pas savoir laquelle des
  // compétences ouvertes le bloque, et il reformule le même appel.
  assert.deepEqual(result.skillStack, ['new-template']);
  assert.match(result.message, /new-template/);
});

test('borne la profondeur même sans cycle', async () => {
  // La détection de cycle ne voit pas une chaîne longue de compétences
  // distinctes, qui épuiserait le budget aussi sûrement.
  const result = await call(session(['a', 'b', 'c']), 'd');

  assert.equal(result.code, 'skill_depth_exceeded');
});

/*
 Cascade observée à l'époque des compétences concepts : un `/wiki-ingest`
 relançait les compétences voisines plusieurs fois pour une seule demande,
 parce que la deuxième intention compilée était mot pour mot le corps d'une
 compétence sœur et que le sélecteur par description la reconnaissait
 légitimement. Ces compétences (rebuild-concepts/reclassify/taxonomy) ont
 disparu avec la simplification 0.15.66 ; la garde contre la récursion, elle,
 reste — c'est elle que ces tests verrouillent.
*/
const callWithObjective = (state, skillName, objective) =>
  handleRuntimeControlTool(state, 'run_skill', { skillName, _userInput: objective })
    .then((raw) => JSON.parse(raw));

test('refuse une compétence voisine que l’intention décrit sans la nommer', async () => {
  const objective = 'Run the production pipeline steps ingest, build, export and polish, in that order.';
  const ran = [];
  const result = await callWithObjective(session(['wiki-ingest'], ran), 'wiki-build', objective);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'nested_skill_match_blocked');
  assert.deepEqual(ran, [], 'un refus ne doit lancer aucun travail');
  assert.match(result.message, /runtime__delegate/);
});

test('laisse passer la compétence que l’intention nomme explicitement', async () => {
  const ran = [];
  const result = await callWithObjective(session(['wiki-sync'], ran), 'deliver', 'Then run /deliver on the produced report.');

  assert.equal(result.ok, true);
  assert.deepEqual(ran, ['deliver']);
});

test('ne confond pas un nom de compétence avec son préfixe', async () => {
  const result = await callWithObjective(session(['pipeline']), 'wiki-build', 'Hand the result to the wiki-builder service.');

  assert.equal(result.code, 'nested_skill_match_blocked');
});

test('un chemin de fichier commençant par un nom de compétence ne vaut pas invocation', async () => {
  const result = await callWithObjective(
    session(['wiki-ingest']),
    'wiki-build',
    'Move the leaf file /wiki-build/unclassified/x.md into place then continue.',
  );

  assert.equal(result.code, 'nested_skill_match_blocked');
});

test('hors de toute chaîne, la sélection par description reste permise', async () => {
  const result = await callWithObjective(session(undefined), 'wiki-build', 'regenerate the deliverables from the templates');

  assert.equal(result.ok, true);
});

/*
 Le nom seul ne prouve rien. Plusieurs compétences du scaffold portent un nom
 qui est aussi un mot courant : « Run the production pipeline steps ingest,
 build, export and polish » nomme `pipeline`, dont le lancement rejoue
 ingest + build + export + polish. Une intention doit citer sa cible EN TANT QUE
 compétence, pas l'employer comme mot.
*/
test('un nom employé comme mot courant ne vaut pas invocation', async () => {
  const objective = 'Run the production pipeline steps ingest, build, export and polish, in that order.';
  const ran = [];
  const result = await callWithObjective(session(['wiki-ingest'], ran), 'pipeline', objective);

  assert.equal(result.code, 'nested_skill_match_blocked');
  assert.deepEqual(ran, []);
});

test('la tournure « the deliver skill » vaut invocation explicite', async () => {
  const ran = [];
  const result = await callWithObjective(session(['wiki-sync'], ran), 'deliver', 'Hand the report to the deliver skill.');

  assert.equal(result.ok, true);
  assert.deepEqual(ran, ['deliver']);
});
