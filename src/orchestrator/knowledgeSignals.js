import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync } from 'node:fs';
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
