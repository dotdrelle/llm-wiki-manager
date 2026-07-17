import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureCacertComposeOverride } from './cacert.js';

test('cacert compose override follows the active certificate path', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-manager-cacert-'));
  const compose = join(root, 'compose.yml');
  const firstCa = join(root, 'first.pem');
  const secondCa = join(root, 'second.pem');
  writeFileSync(compose, 'services:\n  serve:\n    image: example\n', 'utf8');
  writeFileSync(firstCa, 'first', 'utf8');
  writeFileSync(secondCa, 'second', 'utf8');
  const previousCa = process.env.WIKI_MANAGER_CACERT_PATH;
  const previousEnvFile = process.env.WIKI_MANAGER_ENV_FILE;
  process.env.WIKI_MANAGER_ENV_FILE = join(root, '.env');
  try {
    process.env.WIKI_MANAGER_CACERT_PATH = firstCa;
    const override = ensureCacertComposeOverride(compose, 'test-cacert.compose.yml');
    assert.match(readFileSync(override, 'utf8'), new RegExp(firstCa.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    process.env.WIKI_MANAGER_CACERT_PATH = secondCa;
    ensureCacertComposeOverride(compose, 'test-cacert.compose.yml');
    const updated = readFileSync(override, 'utf8');
    assert.match(updated, new RegExp(secondCa.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(updated, new RegExp(firstCa.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (previousCa === undefined) delete process.env.WIKI_MANAGER_CACERT_PATH;
    else process.env.WIKI_MANAGER_CACERT_PATH = previousCa;
    if (previousEnvFile === undefined) delete process.env.WIKI_MANAGER_ENV_FILE;
    else process.env.WIKI_MANAGER_ENV_FILE = previousEnvFile;
  }
});
