import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./SetupWizard.tsx', import.meta.url)),
  'utf8',
);

test('model discovery never blocks a wizard step', () => {
  // La régression d'origine : `await discoverModels()` sur l'étape clé API
  // gelait l'écran pendant tout le délai réseau, sans rien afficher.
  assert.doesNotMatch(source, /await\s+(start|discover)\w*[Dd]iscover\w*\(/);
  assert.doesNotMatch(source, /await\s+fetch(Models|GatewayCatalog)\(/);
  assert.match(source, /startDiscovery\(\{ \.\.\.llm\(\), apiKey: value \}\);\s*\n\s*return navigate\('llm-model'\)/);
});

test('a late answer cannot overwrite a newer discovery', () => {
  assert.match(source, /discoveryRun \+= 1;/);
  assert.match(source, /if \(run !== discoveryRun\) return;/);
});

test('the gateway flat list is shown before the typed catalog', () => {
  assert.match(source, /onPartial:/);
  assert.match(source, /Refining chat\/embedding\/rerank types/);
});

test('the discovery panel reports state, endpoint and transport', () => {
  for (const fragment of [
    'Reading the model catalog',
    'Model catalog unavailable',
    'Cause: ',
    'Transport: ',
    'transportSummary()',
    'model(s) available',
  ]) {
    assert.ok(source.includes(fragment), `discovery panel must show: ${fragment}`);
  }
});

test('the wizard fills the terminal instead of a fixed narrow box', () => {
  const width = source.match(/const dialogWidth = \(\) => ([^;]+);/);
  const height = source.match(/const dialogHeight = \(\) => ([^;]+);/);
  assert.ok(width && height);
  assert.match(width[1], /Math\.min\(1\d\d,/);
  assert.match(height[1], /Math\.min\([34]\d,/);
});
