import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  taxoConflictFingerprint,
  detectTaxoConflicts,
  detectStaleKnowledge,
  normalizeSubject,
  readTaxoConceptPages,
  readSourceRegistry,
  readWikiPages,
  staleFingerprint,
} from './knowledgeSignals.js';

test('normalizeSubject folds case, accents and punctuation', () => {
  assert.equal(normalizeSubject('Jedox Cloud'), 'jedox-cloud');
  assert.equal(normalizeSubject('jedox-cloud'), 'jedox-cloud');
  assert.equal(normalizeSubject('Souveraineté'), 'souverainete');
});

test('a tag assigned to multiple families is one conflict', () => {
  const { conflicts, total } = detectTaxoConflicts([
    { path: 'saas/jedox.md', concept: 'saas', subject: 'Jedox', ficheCount: 1 },
    { path: 'cout/jedox.md', concept: 'cout', subject: 'jedox', ficheCount: 2 },
    { path: 'saas/anaplan.md', concept: 'saas', subject: 'Anaplan', ficheCount: 1 },
  ]);
  assert.equal(total, 1);
  assert.deepEqual(conflicts, [
    { concept: 'cout, saas', subject: 'jedox', paths: ['cout/jedox.md', 'saas/jedox.md'], issue: 'tag-in-multiple-families' },
  ]);
});

test('pages with no fiche citations are reported independently', () => {
  const { conflicts, total } = detectTaxoConflicts([
    { path: 'saas/jedox.md', concept: 'saas', subject: 'Jedox', ficheCount: 0 },
  ]);
  assert.equal(total, 1);
  assert.deepEqual(conflicts[0], {
    concept: 'saas', subject: 'jedox', paths: ['saas/jedox.md'], issue: 'concept-without-fiche',
  });
});

test('the conflict fingerprint is stable and moves past the display ceiling', () => {
  const a = [{ concept: 'cout, saas', subject: 'jedox', issue: 'tag-in-multiple-families', paths: ['saas/b.md', 'saas/a.md'] }];
  const b = [{ concept: 'cout, saas', subject: 'jedox', issue: 'tag-in-multiple-families', paths: ['saas/a.md', 'saas/b.md'] }];
  assert.equal(taxoConflictFingerprint(a, 1), taxoConflictFingerprint(b, 1));
  // A 51st conflict beyond the cap must change the version, or it dedups away.
  assert.notEqual(taxoConflictFingerprint(a, 50), taxoConflictFingerprint(a, 51));
});

test('the ceiling reports what it dropped instead of hiding it', () => {
  const leaves = Array.from({ length: 60 }, (_, index) => [
    { path: `a/s${index}.md`, concept: 'a', subject: `s${index}`, ficheCount: 1 },
    { path: `b/s${index}.md`, concept: 'b', subject: `s${index}`, ficheCount: 1 },
  ]).flat();
  const { conflicts, total, dropped } = detectTaxoConflicts(leaves);
  assert.equal(conflicts.length, 50);
  assert.equal(total, 60);
  assert.equal(dropped, 10);
});

test('readTaxoConceptPages reads tag, family and fiche links from concept pages', () => {
  const root = mkdtempSync(join(tmpdir(), 'signals-'));
  try {
    mkdirSync(join(root, 'wiki', 'concepts', 'saas', 'produits'), { recursive: true });
    mkdirSync(join(root, 'wiki', 'concepts', 'saas', 'vendors'), { recursive: true });
    mkdirSync(join(root, 'wiki', 'concepts', 'cout'), { recursive: true });
    mkdirSync(join(root, 'wiki', 'concepts', 'orphan'), { recursive: true });
    writeFileSync(join(root, 'wiki', 'concepts', 'saas', 'produits', 'jedox.md'), '---\nsubject: Jedox\ntags: [Jedox]\nfamily: saas\n---\n[src: wiki/sources/a.md]');
    writeFileSync(join(root, 'wiki', 'concepts', 'cout', 'jedox.md'), '---\nsubject: Jedox\ntags: [Jedox]\nfamily: cout\n---\n[src: wiki/sources/b.md]');
    writeFileSync(join(root, 'wiki', 'concepts', 'orphan', 'empty.md'), '---\nsubject: Empty\ntags: [empty]\nfamily: orphan\n---\nno fiches');
    writeFileSync(join(root, 'wiki', 'concepts', 'README.txt'), 'ignore me');

    const leaves = readTaxoConceptPages(root);
    assert.deepEqual(
      leaves.map((leaf) => leaf.path).sort(),
      ['cout/jedox.md', 'orphan/empty.md', 'saas/produits/jedox.md'],
    );
    const { conflicts, total } = detectTaxoConflicts(leaves);
    assert.equal(total, 2);
    assert.deepEqual(conflicts.map((item) => item.issue), ['concept-without-fiche', 'tag-in-multiple-families']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a consistent family with cited fiches produces no conflict signal', () => {
  assert.equal(
    detectTaxoConflicts([
      { path: 'saas/a.md', concept: 'saas', subject: 'A', ficheCount: 1 },
      { path: 'saas/b.md', concept: 'saas', subject: 'B', ficheCount: 2 },
    ]).total,
    0,
  );
  assert.equal(detectTaxoConflicts([]).total, 0);
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

test('engine-owned pages are never stale orphans', () => {
  const root = mkdtempSync(join(tmpdir(), 'stale-engine-owned-'));
  try {
    mkdirSync(join(root, 'wiki', 'concepts', 'exigences'), { recursive: true });
    writeFileSync(join(root, 'wiki', 'index.md'), '# Wiki Index\n');
    writeFileSync(join(root, 'wiki', 'log.md'), '# Log\n');
    writeFileSync(
      join(root, 'wiki', 'concepts', 'exigences', 'audit.md'),
      '---\ntype: concept\nfamily: Exigences\ngenerated:\n  by: llm-wiki-tags\n---\n# Audit\n[src: wiki/sources/a/audit.md]\n',
    );
    writeFileSync(
      join(root, 'wiki', 'concepts', 'exigences', 'ancienne-feuille.md'),
      '---\ntype: concept\ngenerated:\n  by: llm-wiki\n---\n# Ancienne\n',
    );
    writeFileSync(join(root, 'wiki', 'concepts', 'exigences', 'main.md'), '# Écrit à la main\n');

    const { stale, counts } = detectStaleKnowledge({ sources: [] }, {
      rootDir: root,
      now: Date.now(),
      exists: () => true,
      wikiPages: readWikiPages(root),
    });

    // The index, the journal and the generated pivot are engine-owned — a TAXO
    // cycle regenerates them, so they were the false positives doctor no
    // longer reports either. The legacy leaf and the hand-written page remain
    // questions for the operator.
    assert.deepEqual(
      stale.filter((entry) => entry.kind === 'orphan').map((entry) => entry.path),
      ['wiki/concepts/exigences/ancienne-feuille.md', 'wiki/concepts/exigences/main.md'],
    );
    assert.equal(counts.orphan, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
