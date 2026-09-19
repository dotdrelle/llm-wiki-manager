import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  conflictFingerprint,
  detectConceptConflicts,
  normalizeSubject,
  readConceptLeaves,
} from './knowledgeSignals.js';

test('normalizeSubject folds case, accents and punctuation', () => {
  assert.equal(normalizeSubject('Jedox Cloud'), 'jedox-cloud');
  assert.equal(normalizeSubject('jedox-cloud'), 'jedox-cloud');
  assert.equal(normalizeSubject('Souveraineté'), 'souverainete');
});

test('two homonym leaves under one concept are one conflict, not two', () => {
  const { conflicts, total } = detectConceptConflicts([
    { path: 'saas/jedox.md', concept: 'saas', subject: 'Jedox' },
    { path: 'saas/jedox-cloud.md', concept: 'saas', subject: 'jedox' },
    { path: 'cout/jedox.md', concept: 'cout', subject: 'Jedox' },
    { path: 'saas/anaplan.md', concept: 'saas', subject: 'Anaplan' },
  ]);
  assert.equal(total, 1);
  assert.deepEqual(conflicts, [
    { concept: 'saas', subject: 'jedox', paths: ['saas/jedox-cloud.md', 'saas/jedox.md'] },
  ]);
});

test('a conflict in nested sub-folders keeps both distinct paths', () => {
  const { conflicts, total } = detectConceptConflicts([
    { path: 'saas/produits/jedox.md', concept: 'saas', subject: 'Jedox' },
    { path: 'saas/vendors/jedox.md', concept: 'saas', subject: 'Jedox' },
  ]);
  assert.equal(total, 1);
  assert.deepEqual(conflicts[0].paths, ['saas/produits/jedox.md', 'saas/vendors/jedox.md']);
});

test('the conflict fingerprint is stable and moves past the display ceiling', () => {
  const a = [{ concept: 'saas', subject: 'jedox', paths: ['saas/b.md', 'saas/a.md'] }];
  const b = [{ concept: 'saas', subject: 'jedox', paths: ['saas/a.md', 'saas/b.md'] }];
  assert.equal(conflictFingerprint(a, 1), conflictFingerprint(b, 1));
  // A 51st conflict beyond the cap must change the version, or it dedups away.
  assert.notEqual(conflictFingerprint(a, 50), conflictFingerprint(a, 51));
});

test('the ceiling reports what it dropped instead of hiding it', () => {
  const leaves = Array.from({ length: 60 }, (_, index) => [
    { path: `c/s${index}-a.md`, concept: 'c', subject: `s${index}` },
    { path: `c/s${index}-b.md`, concept: 'c', subject: `s${index}` },
  ]).flat();
  const { conflicts, total, dropped } = detectConceptConflicts(leaves);
  assert.equal(conflicts.length, 50);
  assert.equal(total, 60);
  assert.equal(dropped, 10);
});

test('readConceptLeaves takes the folder as the concept and the frontmatter as the subject', () => {
  const root = mkdtempSync(join(tmpdir(), 'signals-'));
  try {
    mkdirSync(join(root, 'wiki', 'concepts', 'saas', 'produits'), { recursive: true });
    mkdirSync(join(root, 'wiki', 'concepts', 'saas', 'vendors'), { recursive: true });
    mkdirSync(join(root, 'wiki', 'concepts', 'cout'), { recursive: true });
    writeFileSync(join(root, 'wiki', 'concepts', 'saas', 'produits', 'jedox.md'), '---\nsubject: Jedox\n---\nbody');
    writeFileSync(join(root, 'wiki', 'concepts', 'saas', 'vendors', 'jedox.md'), '---\nsubject: Jedox\n---\nbody');
    writeFileSync(join(root, 'wiki', 'concepts', 'cout', 'jedox.md'), 'no frontmatter\n');
    writeFileSync(join(root, 'wiki', 'concepts', 'README.txt'), 'ignore me');

    const leaves = readConceptLeaves(root);
    assert.deepEqual(
      leaves.map((leaf) => leaf.path).sort(),
      ['cout/jedox.md', 'saas/produits/jedox.md', 'saas/vendors/jedox.md'],
    );
    const { conflicts, total } = detectConceptConflicts(leaves);
    assert.equal(total, 1);
    assert.equal(conflicts[0].concept, 'saas');
    assert.deepEqual(conflicts[0].paths, ['saas/produits/jedox.md', 'saas/vendors/jedox.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corpus without homonyms produces no signal', () => {
  assert.equal(
    detectConceptConflicts([
      { path: 'saas/a.md', concept: 'saas', subject: 'A' },
      { path: 'saas/b.md', concept: 'saas', subject: 'B' },
    ]).total,
    0,
  );
  assert.equal(detectConceptConflicts([]).total, 0);
});
