import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { managerRoot } from './workspaces.js';

const SKILL_NAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;

function parseFrontmatter(raw) {
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

function readSkillFile(filePath, fallbackName, scope) {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const name = String(meta.name || fallbackName).trim();
  if (!SKILL_NAME_RE.test(name)) return null;
  return {
    name,
    description: String(meta.description || '').trim(),
    params: Array.isArray(meta.params) ? meta.params : [],
    body,
    scope,
    path: filePath,
  };
}

function collectDirectorySkills(dir, scope) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .flatMap((entry) => {
      const filePath = join(dir, entry.name);
      const skill = readSkillFile(filePath, basename(entry.name, '.md'), scope);
      return skill ? [skill] : [];
    });
}

export function listSkills(session = {}) {
  const skills = [];
  const rootSkill = join(managerRoot(), 'SKILL.md');
  if (existsSync(rootSkill)) {
    const skill = readSkillFile(rootSkill, 'agent-cme-llm-wiki-pipeline', 'manager');
    if (skill) skills.push(skill);
  }
  skills.push(...collectDirectorySkills(join(managerRoot(), 'skills'), 'manager'));

  if (session.workspacePath) {
    const workspaceSkill = join(session.workspacePath, 'SKILL.md');
    if (existsSync(workspaceSkill)) {
      const skill = readSkillFile(workspaceSkill, `${session.workspace}-workflow`, 'workspace');
      if (skill) skills.push(skill);
    }
    skills.push(...collectDirectorySkills(join(session.workspacePath, 'skills'), 'workspace'));
    skills.push(...collectDirectorySkills(join(session.workspacePath, '.wiki', 'skills'), 'workspace'));
  }

  const byName = new Map();
  for (const skill of skills) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(session, name) {
  return listSkills(session).find((skill) => skill.name === name) ?? null;
}

export function formatSkillsForAgent(session) {
  const skills = listSkills(session);
  if (!skills.length) return 'No skills discovered.';
  return skills
    .map((skill) => `/${skill.name}: ${skill.description || 'workflow skill'} (${skill.scope})`)
    .join('\n');
}
