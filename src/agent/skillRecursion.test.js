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
