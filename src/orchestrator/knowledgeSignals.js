import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

/*
 Deterministic corpus signals: what the LIVE wiki says about itself, with no
 model and no ingest plan in the loop.

 `detectConceptSplits` only ever saw the current ingest plan, and
 `subjectMatchInventory` builds a prompt context without producing a
 persistent diagnosis — so two homonym leaves already written under one concept
 folder were invisible until now. This reads the corpus on disk and reports the
 paths, nothing else.
*/

// Case, accents and punctuation are not meaning.
export function normalizeSubject(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Two homonym leaves under one concept are ONE conflict. The result is bounded
 * for display, but `total` counts the whole set and `dropped` names what the
 * ceiling hid — a silent cap would also freeze the fingerprint below.
 */
export function detectConceptConflicts(leaves, { max = 50 } = {}) {
  const groups = new Map();
  for (const leaf of leaves ?? []) {
    const concept = String(leaf?.concept ?? '').trim();
    const subject = normalizeSubject(leaf?.subject);
    const path = String(leaf?.path ?? '').trim();
    if (!concept || !subject || !path) continue;
    const key = `${concept}\u0000${subject}`;
    const group = groups.get(key) ?? { concept, subject, paths: [] };
    group.paths.push(path);
    groups.set(key, group);
  }
  const all = [...groups.values()]
    .map((group) => ({ ...group, paths: [...new Set(group.paths)].sort() }))
    .filter((group) => group.paths.length > 1)
    .sort((a, b) => a.concept.localeCompare(b.concept) || a.subject.localeCompare(b.subject));
  const conflicts = all.slice(0, max);
  return { conflicts, total: all.length, dropped: all.length - conflicts.length };
}

/**
 * A stable version for the trigger. `total` participates on purpose: a 51st
 * conflict appearing later must MOVE the fingerprint even though it is beyond
 * the display ceiling — otherwise it would dedup as already-seen and the corpus
 * could degrade with no review.
 */
export function conflictFingerprint(conflicts, total = Array.isArray(conflicts) ? conflicts.length : 0) {
  const lines = (conflicts ?? [])
    .map((conflict) => `${conflict.concept}/${conflict.subject}:${[...conflict.paths].sort().join('|')}`)
    .sort();
  lines.push(`total:${total}`);
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

function frontmatterSubject(raw) {
  if (!raw || !raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  try {
    const data = parseYaml(raw.slice(3, end)) ?? {};
    const subject = data.subject ?? data.title;
    return subject == null ? null : String(subject);
  } catch {
    return null;
  }
}

// The frontmatter is at the top of the file; reading a whole page to look at
// its header is the cost the manager cannot pay synchronously on its event
// loop (the same reason llm-wiki's sidebar reads a bounded head).
function readFileHead(filePath, maxBytes = 4_096) {
  let handle;
  try {
    handle = openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(handle, buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytes);
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try { closeSync(handle); } catch { /* already gone */ }
    }
  }
}

/**
 * Every `.md` under `wiki/concepts/`, with its top-level concept folder, its
 * subject (frontmatter `subject`, else the file name) and its path RELATIVE to
 * `wiki/concepts/` — nested folders included, so two leaves in different
 * sub-folders still report two DISTINCT paths.
 */
/**
 * The engine's source registry (`.wiki/source-registry.json`), read as the
 * stable contract it is. Unreadable or corrupt yields no sources: a failed
 * observation never breaks the run that triggered it.
 */
export function readSourceRegistry(rootDir) {
  let raw;
  try {
    raw = readFileSync(join(String(rootDir), '.wiki', 'source-registry.json'), 'utf8');
  } catch {
    return { sources: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return { sources: Array.isArray(parsed?.sources) ? parsed.sources : [] };
  } catch {
    return { sources: [] };
  }
}

/**
 * Every `.md` under `wiki/`, relative to the workspace — the inventory the
 * engine's `reconcileRegistry` calls `wikiPages`. Names only, no content.
 */
export function readWikiPages(rootDir, { max = 5_000 } = {}) {
  const base = join(String(rootDir), 'wiki');
  const pages = [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true, recursive: true });
  } catch {
    return pages;
  }
  const toPosix = (value) => value.split(sep).join('/');
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const parent = entry.parentPath ?? entry.path;
    if (!parent) continue;
    const rel = toPosix(relative(base, join(parent, entry.name)));
    if (!rel || rel.startsWith('..')) continue;
    pages.push(`wiki/${rel}`);
    if (pages.length >= max) break;
  }
  return pages.sort();
}

// The engine's `orphanPages` rule: a page no ACTIVE source lists among the pages
// it produced. A hand-written or pre-registry page is an orphan too — a
// provenance gap the operator is asked about, never a deletion.
function orphanPagesFromRegistry(registry, wikiPages) {
  const supported = new Set(
    (registry?.sources ?? [])
      .filter((source) => String(source?.status ?? 'active') === 'active')
      .flatMap((source) => (Array.isArray(source?.producedPages) ? source.producedPages.map(String) : [])),
  );
  return wikiPages.map(String).filter((page) => !supported.has(page)).sort();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The registry's own deterministic staleness facts, with no rule to mirror:
 *
 * - `aged` — an active source whose `lastIngestedAt` (the engine writes it) is
 *   older than the window. A source never ingested (`null`) is not "aging
 *   knowledge", it simply produced none;
 * - `vanished-archive` / `vanished-page` — the registry names a path that no
 *   longer exists. Existence is existence: this is the engine's
 *   `reconcileRegistry` truth, reached without re-implementing its rules.
 *
 * (Orphans — a wiki page no active source backs — need the full wiki inventory
 * and the supported-set rule; that one stays the engine's to expose.)
 * Bounded like the conflict scan: `total` counts the whole set.
 */
export function detectStaleKnowledge(registry, {
  rootDir = '',
  now = Date.now(),
  staleAfterDays = 180,
  max = 50,
  exists = existsSync,
  // The `wiki/**/*.md` inventory (`readWikiPages`), when the caller has it:
  // orphan detection is a join on the registry, nothing more.
  wikiPages = null,
} = {}) {
  const cutoff = Number(now) - staleAfterDays * DAY_MS;
  const evidence = [];
  // Counted per kind over the FULL set: the ceiling line must describe the
  // facts it is capping, not lump natures into one number. "61 source(s) not
  // re-verified" sent the reader looking for the wrong defect.
  const counts = { aged: 0, vanishedArchive: 0, vanishedPage: 0, orphan: 0 };
  for (const source of registry?.sources ?? []) {
    if (String(source?.status ?? 'active') !== 'active') continue;
    const sourceId = String(source?.sourceId ?? '');
    const archivePath = String(source?.archivePath ?? '');
    if (archivePath && !exists(join(String(rootDir), archivePath))) {
      evidence.push({ kind: 'vanished-archive', sourceId, path: archivePath });
      counts.vanishedArchive += 1;
    }
    for (const page of source?.producedPages ?? []) {
      const pagePath = String(page ?? '');
      if (pagePath && !exists(join(String(rootDir), pagePath))) {
        evidence.push({ kind: 'vanished-page', sourceId, path: pagePath });
        counts.vanishedPage += 1;
      }
    }
    const lastIngestedAt = source?.lastIngestedAt ?? null;
    const observed = Date.parse(String(lastIngestedAt ?? ''));
    if (Number.isFinite(observed) && observed <= cutoff) {
      evidence.push({ kind: 'aged', sourceId, path: archivePath, lastIngestedAt });
      counts.aged += 1;
    }
  }
  if (Array.isArray(wikiPages)) {
    for (const page of orphanPagesFromRegistry(registry, wikiPages)) {
      evidence.push({ kind: 'orphan', sourceId: null, path: page });
      counts.orphan += 1;
    }
  }
  evidence.sort((a, b) => a.kind.localeCompare(b.kind)
    || a.path.localeCompare(b.path)
    || String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? '')));
  const stale = evidence.slice(0, max);
  return { stale, total: evidence.length, dropped: evidence.length - stale.length, counts };
}

export function staleFingerprint(stale, total = Array.isArray(stale) ? stale.length : 0) {
  const lines = (stale ?? [])
    .map((entry) => `${entry.kind}:${entry.sourceId}:${entry.path}:${entry.lastIngestedAt ?? ''}`)
    .sort();
  lines.push(`total:${total}`);
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export function readConceptLeaves(rootDir) {
  const base = join(String(rootDir), 'wiki', 'concepts');
  const leaves = [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true, recursive: true });
  } catch {
    return leaves;
  }
  const toPosix = (value) => value.split(sep).join('/');
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const parent = entry.parentPath ?? entry.path;
    if (!parent) continue;
    const rel = toPosix(relative(base, join(parent, entry.name)));
    if (!rel || rel.startsWith('..')) continue;
    const concept = rel.split('/')[0];
    if (!concept) continue;
    const head = readFileHead(join(parent, entry.name));
    const subject = frontmatterSubject(head) ?? entry.name.replace(/\.md$/, '');
    leaves.push({ path: rel, concept, subject });
  }
  return leaves;
}
