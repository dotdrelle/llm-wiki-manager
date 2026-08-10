import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SKILL_PARAM_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const DANGEROUS_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_UI_SKILL_DIR = '.wiki/skills';
// The CSI branch must come FIRST. `[` is 0x5B, inside the `[@-_]` range, so the
// two-character alternative would otherwise consume `ESC [` alone and leave the
// parameter bytes behind as literal text: "\x1B[31m" would become "31m".
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const MAX_SKILL_DESCRIPTION_LENGTH = 200;

function descriptionMetadata(value) {
  const normalized = String(value || '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(CONTROL_CHARACTER_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    value: normalized.slice(0, MAX_SKILL_DESCRIPTION_LENGTH),
    missing: normalized.length === 0,
    truncated: normalized.length > MAX_SKILL_DESCRIPTION_LENGTH,
  };
}

function escapePromptData(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta = {};
  let inParams = false;
  const params = [];
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === 'params:') {
      inParams = true;
      continue;
    }
    if (inParams && trimmed.startsWith('- ')) {
      params.push(trimmed.slice(2).trim());
      continue;
    }
    inParams = false;
    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;
    meta[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
  }
  if (params.length) meta.params = params;
  return { meta, body: match[2].trim() };
}

function inspectSkillFile(filePath, fallbackName, scope, root) {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const name = String(meta.name || fallbackName).trim();
  const relativePath = relative(root, filePath);
  if (!SKILL_NAME_RE.test(name)) return { rejected: { relativePath, name: name || undefined, reason: 'invalid_name' } };
  const params = Array.isArray(meta.params) ? meta.params.map((item) => String(item).trim()) : [];
  if (params.length > 12) return { rejected: { relativePath, name, reason: 'too_many_params' } };
  if (new Set(params).size !== params.length) return { rejected: { relativePath, name, reason: 'duplicate_param' } };
  if (params.some((param) => !SKILL_PARAM_RE.test(param) || DANGEROUS_PARAM_NAMES.has(param))) {
    return { rejected: { relativePath, name, reason: 'invalid_param' } };
  }
  const description = descriptionMetadata(meta.description);
  const skill = {
    name,
    description: description.value,
    params,
    body,
    scope,
    path: filePath,
  };
  const warnings = [];
  if (description.missing) warnings.push({ relativePath, name, reason: 'missing_description' });
  else if (description.truncated) warnings.push({ relativePath, name, reason: 'description_truncated' });
  return { skill, warnings };
}

export function readOptionalText(filePath) {
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf8').trim();
}

function inspectDirectorySkills(dir, scope, root) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .flatMap((entry) => {
      const filePath = join(dir, entry.name);
      return [inspectSkillFile(filePath, basename(entry.name, '.md'), scope, root)];
    });
}

export function inspectSkills(session = {}) {
  const inspected = [];
  if (session.workspacePath) {
    const root = join(session.workspacePath, DEFAULT_UI_SKILL_DIR);
    inspected.push(...inspectDirectorySkills(root, 'workspace', root));
  }
  const rejected = inspected.flatMap((item) => item.rejected ? [item.rejected] : []);
  const warnings = inspected.flatMap((item) => item.warnings ?? []);
  const candidates = inspected.flatMap((item) => item.skill ? [item.skill] : []);
  const groups = Map.groupBy(candidates, (skill) => skill.name.toLowerCase());
  const duplicatePaths = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const skill of group) {
      const relativePath = relative(join(session.workspacePath, DEFAULT_UI_SKILL_DIR), skill.path);
      duplicatePaths.add(skill.path);
      rejected.push({ relativePath, name: skill.name, reason: 'duplicate_name' });
    }
  }
  const skills = candidates.filter((skill) => !duplicatePaths.has(skill.path))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { skills, rejected, warnings };
}

export function listSkills(session = {}) {
  return inspectSkills(session).skills;
}

export function findSkill(session, name) {
  const normalized = String(name ?? '').toLowerCase();
  return listSkills(session).find((skill) => skill.name.toLowerCase() === normalized) ?? null;
}

export function formatSkillsForAgent(session) {
  const skills = listSkills(session);
  if (!skills.length) return 'No skills discovered.';
  return skills
    .map((skill) => `/${skill.name}${skill.params.length ? ` [${skill.params.map((param) => `<${param}>`).join(' ')}]` : ''}: ${escapePromptData(skill.description || 'workflow skill')}${skill.description ? '' : ' [explicit name only]'} (${skill.scope})`)
    .join('\n');
}
