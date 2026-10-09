import assert from 'node:assert/strict';
import test from 'node:test';
import { presearchFoundNote } from './wikiPresearch.js';

// The step line after "Searching": counts only, never an excerpt.
test('the pre-search says what it found, in counts', () => {
  const payload = (results) => JSON.stringify({ question: 'q', results });
  assert.equal(
    presearchFoundNote(payload([{ path: 'wiki/a.md', excerpt: 'secret' }, { path: 'wiki/a.md' }, { path: 'wiki/b.md' }])),
    'Wiki search: 3 passages from 2 pages',
  );
  assert.equal(presearchFoundNote(payload([{ path: 'wiki/a.md' }])), 'Wiki search: 1 passage from 1 page');
  assert.equal(presearchFoundNote(payload([])), 'Wiki search: nothing found');
  assert.equal(presearchFoundNote('not json'), '');
  assert.equal(presearchFoundNote(JSON.stringify({ other: 1 })), '');
});
