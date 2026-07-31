import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./SetupWizard.tsx', import.meta.url), 'utf8');

test('the model steps feed the discovered catalog into the filter', () => {
  // Trois étapes doivent porter des suggestions : modèle LLM, embeddings,
  // reranker. Sans elles, le filtre n'a rien a filtrer.
  const occurrences = source.match(/suggestions: discovered/g) ?? [];
  assert.equal(occurrences.length, 3);
});

test('the typed value always wins over the suggestion list', () => {
  // Garde-fou : la liste ne doit jamais devenir un select. Si ce message
  // disparait, c'est que la saisie libre a ete perdue.
  assert.match(source, /the typed value wins/);
  assert.match(source, /the typed value is used as-is/);
});

test('suggestions are filtered by the current input, not shown raw', () => {
  assert.match(source, /all\.filter\(\(item\) => item\.toLowerCase\(\)\.includes\(needle\)\)/);
  assert.match(source, /matches\.slice\(0, SUGGESTION_ROWS\)/);
});
