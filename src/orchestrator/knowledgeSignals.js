import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

/* Deterministic TAXO corpus signals; no model or intermediate ingest plan. */

// Case, accents and punctuation are not meaning.
export function normalizeSubject(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Report cross-family tags and concept pages that have no fiche citation.
 * Output is bounded for display, but `total` includes the full set.
 */
export function detectTaxoConflicts(pages, { max = 50 } = {}) {
  const groups = new Map();
  const conflicts = [];
  for (const page of pages ?? []) {
    const concept = String(page?.concept ?? '').trim();
    const subject = normalizeSubject(page?.subject);
    const path = String(page?.path ?? '').trim();
    if (!concept || !subject || !path) continue;
    const key = subject;
    const group = groups.get(key) ?? { subject, families: new Map() };
    const paths = group.families.get(concept) ?? [];
    paths.push(path);
    group.families.set(concept, paths);
    groups.set(key, group);
    if (Number(page?.ficheCount ?? 1) === 0) {
      conflicts.push({ concept, subject, paths: [path], issue: 'concept-without-fiche' });
    }
  }
  for (const group of groups.values()) {
    if (group.families.size < 2) continue;
    conflicts.push({
      concept: [...group.families.keys()].sort().join(', '),
      subject: group.subject,
      paths: [...group.families.values()].flat().sort(),
      issue: 'tag-in-multiple-families',
    });
  }
  conflicts.sort((a, b) => a.issue.localeCompare(b.issue)
    || a.concept.localeCompare(b.concept) || a.subject.localeCompare(b.subject));
  const visible = conflicts.slice(0, max);
  return { conflicts: visible, total: conflicts.length, dropped: conflicts.length - visible.length };
}

/**
 * A stable version for the trigger. `total` participates on purpose: a 51st
 * conflict appearing later must MOVE the fingerprint even though it is beyond
 * the display ceiling — otherwise it would dedup as already-seen and the corpus
 * could degrade with no review.
 */
export function taxoConflictFingerprint(conflicts, total = Array.isArray(conflicts) ? conflicts.length : 0) {
  const lines = (conflicts ?? [])
    .map((conflict) => `${conflict.issue ?? 'conflict'}:${conflict.concept}/${conflict.subject}:${[...conflict.paths].sort().join('|')}`)
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
 * Read generated/navigation pages under `wiki/concepts/`, extracting their
 * family, tag and count of section-fiche citations.
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

// Mirror of the engine's `isEngineOwnedWikiPage`
// (llm-wiki/src/services/sourceRegistry.ts): the deterministic index and
// journal, and a generated TAXO pivot (`wiki/concepts/**`, `by:
// llm-wiki-tags`), can never appear in a source's `producedPages` — a pivot
// aggregates fiches from many sources. Counting them as `knowledge.stale`
// orphans asked the operator about pages a TAXO cycle regenerates or purges;
// the engine's doctor applies the same exclusion. An unreadable page is
// reported, never silently dropped.
const ENGINE_OWNED_WIKI_PATHS = new Set(['wiki/index.md', 'wiki/log.md']);
function isEngineOwnedWikiPage(rootDir, pagePath) {
  const page = String(pagePath);
  if (ENGINE_OWNED_WIKI_PATHS.has(page)) return true;
  if (!page.startsWith('wiki/concepts/')) return false;
  const head = readFileHead(join(String(rootDir), page));
  return /^\s*by:\s*llm-wiki-tags\s*$/m.test(head ?? '');
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
      if (isEngineOwnedWikiPage(rootDir, page)) continue;
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

export function readTaxoConceptPages(rootDir) {
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
    const fallbackFamily = rel.split('/')[0];
    if (!fallbackFamily) continue;
    const absolute = join(parent, entry.name);
    let raw;
    try { raw = readFileSync(absolute, 'utf8'); } catch { continue; }
    const head = raw.slice(0, 4_096);
    let data = {};
    if (head.startsWith('---')) {
      const end = head.indexOf('\n---', 3);
      if (end !== -1) {
        try { data = parseYaml(head.slice(3, end)) ?? {}; } catch { data = {}; }
      }
    }
    const subject = Array.isArray(data.tags) && data.tags.length
      ? String(data.tags[0])
      : frontmatterSubject(head) ?? entry.name.replace(/\.md$/, '');
    const concept = String(data.family ?? fallbackFamily);
    const ficheCount = (raw.match(/\[src:\s*wiki\/sources\//g) ?? []).length;
    leaves.push({ path: rel, concept, subject, ficheCount });
  }
  return leaves;
}
