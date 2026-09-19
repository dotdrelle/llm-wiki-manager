import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  conflictFingerprint,
  detectConceptConflicts,
  detectStaleKnowledge,
  normalizeSubject,
  readConceptLeaves,
  readSourceRegistry,
  readWikiPages,
  staleFingerprint,
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

test('stale knowledge is aged sources plus registry paths that no longer exist', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const recent = '2026-05-30T00:00:00.000Z';
  const registry = {
    sources: [
      { sourceId: 'a', archivePath: 'raw/ingested/a.md', status: 'active', lastIngestedAt: recent, producedPages: ['wiki/concepts/saas/a.md'] },
      { sourceId: 'b', archivePath: 'raw/ingested/b.md', status: 'active', lastIngestedAt: recent, producedPages: [] },
      { sourceId: 'e', archivePath: 'raw/ingested/e.md', status: 'active', lastIngestedAt: recent, producedPages: ['wiki/concepts/saas/e-gone.md'] },
      { sourceId: 'f', archivePath: 'raw/ingested/f.md', status: 'active', lastIngestedAt: '2025-01-01T00:00:00.000Z', producedPages: [] },
      { sourceId: 'g', archivePath: 'raw/ingested/g.md', status: 'retracted', lastIngestedAt: '2024-01-01T00:00:00.000Z', producedPages: [] },
      { sourceId: 'h', archivePath: 'raw/ingested/h.md', status: 'active', lastIngestedAt: null, producedPages: [] },
    ],
  };
  // Only b's archive and e's produced page are gone.
  const exists = (path) => !path.includes('raw/ingested/b.md') && !path.endsWith('e-gone.md');

  const { stale, total, dropped, counts } = detectStaleKnowledge(registry, {
    rootDir: '/ws', now, staleAfterDays: 180, exists,
  });
  assert.equal(total, 3, 'a recent, a retracted and a never-ingested source are not stale');
  assert.equal(dropped, 0);
  assert.deepEqual(counts, { aged: 1, vanishedArchive: 1, vanishedPage: 1, orphan: 0 });
  assert.deepEqual(stale.map((entry) => entry.kind), ['aged', 'vanished-archive', 'vanished-page']);
  assert.equal(stale.find((entry) => entry.kind === 'aged').sourceId, 'f');
  assert.equal(stale.find((entry) => entry.kind === 'vanished-archive').path, 'raw/ingested/b.md');
  assert.equal(stale.find((entry) => entry.kind === 'vanished-page').path, 'wiki/concepts/saas/e-gone.md');
});

test('the stale fingerprint is stable and counts the whole set', () => {
  const a = [{ kind: 'aged', sourceId: 'b', path: 'raw/ingested/b.md', lastIngestedAt: '2025-01-01T00:00:00.000Z' }];
  assert.equal(staleFingerprint(a, 1), staleFingerprint(a, 1));
  assert.notEqual(staleFingerprint(a, 1), staleFingerprint(a, 2));
});

test('readSourceRegistry tolerates an absent or corrupt file', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    assert.deepEqual(readSourceRegistry(root), { sources: [] });
    mkdirSync(join(root, '.wiki'), { recursive: true });
    writeFileSync(join(root, '.wiki', 'source-registry.json'), '{not json');
    assert.deepEqual(readSourceRegistry(root), { sources: [] });
    writeFileSync(
      join(root, '.wiki', 'source-registry.json'),
      JSON.stringify({ version: 1, sources: [{ sourceId: 'a' }] }),
    );
    assert.equal(readSourceRegistry(root).sources.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a wiki page no active source backs is an orphan fact', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const recent = '2026-05-30T00:00:00.000Z';
  const registry = {
    sources: [
      { sourceId: 'a', archivePath: 'raw/ingested/a.md', status: 'active', lastIngestedAt: recent, producedPages: ['wiki/concepts/saas/a.md'] },
      { sourceId: 'b', archivePath: 'raw/ingested/b.md', status: 'retracted', lastIngestedAt: recent, producedPages: ['wiki/concepts/saas/retracted.md'] },
    ],
  };
  const { stale, counts } = detectStaleKnowledge(registry, {
    rootDir: '/ws',
    now,
    staleAfterDays: 180,
    exists: () => true,
    wikiPages: ['wiki/concepts/saas/a.md', 'wiki/concepts/saas/handwritten.md', 'wiki/concepts/saas/retracted.md'],
  });
  // A page backed by an ACTIVE source is not an orphan; a hand-written one and
  // one produced by a RETRACTED source are.
  assert.deepEqual(
    stale.filter((entry) => entry.kind === 'orphan').map((entry) => entry.path),
    ['wiki/concepts/saas/handwritten.md', 'wiki/concepts/saas/retracted.md'],
  );
  assert.equal(counts.orphan, 2);

  // Without the inventory, no orphan kind is invented.
  const without = detectStaleKnowledge(registry, { rootDir: '/ws', now, exists: () => true });
  assert.equal(without.stale.some((entry) => entry.kind === 'orphan'), false);
});

test('readWikiPages inventories wiki/**/*.md, names only', () => {
  const root = mkdtempSync(join(tmpdir(), 'wikipages-'));
  try {
    mkdirSync(join(root, 'wiki', 'concepts', 'saas'), { recursive: true });
    mkdirSync(join(root, 'wiki', 'answers'), { recursive: true });
    writeFileSync(join(root, 'wiki', 'concepts', 'saas', 'a.md'), 'x');
    writeFileSync(join(root, 'wiki', 'answers', 'b.md'), 'x');
    writeFileSync(join(root, 'wiki', 'notes.txt'), 'x');
    assert.deepEqual(readWikiPages(root), ['wiki/answers/b.md', 'wiki/concepts/saas/a.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
