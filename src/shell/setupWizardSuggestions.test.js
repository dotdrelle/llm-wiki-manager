import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./SetupWizard.tsx', import.meta.url), 'utf8');

test('the model steps feed the discovered catalog into the filter', () => {
  // Trois étapes doivent porter des suggestions : modèle LLM, embeddings,
  // reranker. Sans elles, le filtre n'a rien a filtrer.
  const occurrences = source.match(/\.\.\.suggestionField\(/g) ?? [];
  assert.equal(occurrences.length, 3);
  assert.match(source, /suggestions: discovered/);
});

test('no model is preselected when a catalog was discovered', () => {
  // Preremplir avec le premier modele decouvert filtrait la liste sur
  // lui-meme : neuf entrees sur dix devenaient invisibles.
  assert.match(source, /prefill: usable \?\? \(discovered\.length === 0 \? example : ''\)/);
  assert.doesNotMatch(source, /prefill: [^\n]*discovered\[0\]/);
});

test('a configured model absent from the catalog is not prefilled', () => {
  // Le `BAAI/bge-m3` du scaffold face a un serveur qui nomme le meme modele
  // `bge-m3` : preremplir filtrait la liste sur zero resultat, et l'ecran
  // affichait « No match » devant dix modeles disponibles.
  assert.match(source, /discovered\.length === 0 \|\| discovered\.includes\(configured\)/);
  assert.match(source, /is not in this catalog — pick one below/);
});

test('the list is navigable with the arrows and confirmed in two steps', () => {
  assert.match(source, /keyName === 'down' \|\| keyName === 'up'/);
  assert.match(source, /if \(hovered && \(isEnter \|\| keyName === 'tab'\)\)/);
  // Le premier Enter depose la valeur, il ne valide pas l'etape.
  assert.match(source, /setInput\(hovered\);\s*\n\s*setHighlight\(-1\);\s*\n\s*return;/);
});

test('the typed value always wins over the suggestion list', () => {
  // Garde-fou : la liste ne doit jamais devenir un select. Si ce message
  // disparait, c'est que la saisie libre a ete perdue.
  assert.match(source, /the typed value wins/);
  assert.match(source, /the typed value is used as-is/);
});

test('suggestions are filtered by the current input, not shown raw', () => {
  assert.match(source, /all\.filter\(\(item\) => item\.toLowerCase\(\)\.includes\(needle\)\)/);
  // Fenetre glissante : la liste defile au lieu de s'arreter aux premieres
  // entrees, sinon un catalogue de 200 modeles reste inatteignable.
  assert.match(source, /matches\.slice\(offset, offset \+ SUGGESTION_ROWS\)/);
});

test('the language typed by the operator is the one displayed back', () => {
  // Sans ce setLanguage, le recapitulatif affichait la langue lue dans le
  // scaffold a la creation du workspace, pas celle qui vient d'etre saisie.
  assert.match(
    source,
    /writeLanguageConfig\([^)]*\);\s*(\n\s*\/\/[^\n]*)*\n\s*setLanguage\(lang\);/,
  );
});
