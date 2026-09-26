import assert from 'node:assert/strict';
import test from 'node:test';
import { compactLogLabel } from './logLabel.js';

test('a log label is the first line of the objective, bounded', () => {
  const objective = 'Curate the wiki: find duplicate pages.\n\n## Boundaries\n\nThis workflow never fetches sources.';
  assert.equal(compactLogLabel(objective), 'Curate the wiki: find duplicate pages.');
  const long = compactLogLabel('x'.repeat(300));
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('…'));
  assert.equal(compactLogLabel('\n\n  Ingest  \n'), 'Ingest');
});
