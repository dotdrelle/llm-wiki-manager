import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wizardPath = fileURLToPath(new URL('./SetupWizard.tsx', import.meta.url));
const scaffoldPath = fileURLToPath(
  new URL('../../../llm-wiki/scaffold/workspace/.wikirc.yaml', import.meta.url),
);

function placeholderRegex() {
  const source = readFileSync(wizardPath, 'utf8');
  const match = source.match(/^const PLACEHOLDER_VALUE_RE = \/(.+)\/i;$/m);
  assert.ok(match, 'PLACEHOLDER_VALUE_RE must stay a single-line literal the tests can read');
  return new RegExp(match[1], 'i');
}

test('the wizard treats scaffolded config values as unset', { skip: !existsSync(scaffoldPath) && 'llm-wiki sibling checkout not available' }, () => {
  const regex = placeholderRegex();
  const scaffold = readFileSync(scaffoldPath, 'utf8');

  // Cross-repo guard: if the scaffold ever ships a different fake endpoint or
  // secret, the wizard would prefill it as a real answer and a skipped step
  // would write it to the operator's config.
  // `embeddingModel` et `rerankerModel` ont ete ajoutes ici apres coup : ils
  // etaient les seuls champs du scaffold a porter une valeur d'apparence reelle
  // (`BAAI/bge-m3`), que le wizard preremplissait donc comme une reponse
  // choisie — et qui filtrait le catalogue sur zero resultat des que le serveur
  // nommait le meme modele autrement.
  const placeholders = [
    ...scaffold.matchAll(/^\s*(baseUrl|apiKey|model|embeddingModel|rerankerModel):\s*(\S+)\s*$/gm),
  ].map(([, key, value]) => [key, value]);

  assert.ok(placeholders.length >= 6, 'expected the scaffold to declare endpoints, secrets and models');
  for (const key of ['embeddingModel', 'rerankerModel']) {
    assert.ok(
      placeholders.some(([name]) => name === key),
      `the scaffold must declare ${key} so this guard covers it`,
    );
  }
  for (const [key, value] of placeholders) {
    assert.match(value, regex, `scaffolded ${key}=${value} must be recognised as a placeholder`);
  }
});

test('preloading a profile filters placeholders out of every prefilled field', () => {
  const source = readFileSync(wizardPath, 'utf8');

  for (const field of [
    'baseUrl: configuredValue(config.llm.baseUrl)',
    'apiKey: configuredValue(config.llm.apiKey)',
    'model: configuredValue(config.llm.model)',
    'baseUrl: configuredValue(config.retrieval.vector.baseUrl)',
    'apiKey: configuredValue(config.retrieval.vector.apiKey)',
    'embeddingModel: configuredValue(config.retrieval.vector.embeddingModel)',
    'rerankerModel: configuredValue(config.retrieval.vector.rerankerModel)',
  ]) {
    assert.ok(source.includes(field), `preloadWikirc must filter ${field}`);
  }

  // With the vector URL filtered to null, this is what makes the embeddings
  // step offer the base URL the operator just typed.
  assert.match(source, /const baseUrl = vector\(\)\.baseUrl \|\| llm\(\)\.baseUrl;/);
  assert.match(source, /baseUrl: old\.baseUrl \|\| llm\(\)\.baseUrl \|\| defaultBaseUrl\(llm\(\)\.provider, llm\(\)\.engine\)/);
});

test('a real configuration is never mistaken for a placeholder', () => {
  const regex = placeholderRegex();

  for (const value of [
    'https://albert.api.etalab.gouv.fr/v1',
    'http://localhost:11434',
    'https://api.openai.com',
    'BAAI/bge-m3',
    'gpt-oss-120b',
  ]) {
    assert.doesNotMatch(value, regex, `${value} must be kept as a configured value`);
  }
});
