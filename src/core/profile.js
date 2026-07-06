import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_PROFILE = `# Workspace Profile

## Summary

No profile summary yet.

## User Preferences

## Working Style

## Project Context

## Maintenance Notes

Keep this file concise. Do not store secrets, tokens, passwords, API keys, or temporary information.
`;

const PROFILE_UPDATE_RE = /^\s*(?:ajoute|ajouter|note|noter|retiens|retenir|m[ée]morise|m[ée]moriser|souviens-toi|souviens|enregistre|enregistrer|remember|save|persist)\b\s+(.+?)\s*$/i;

export function extractProfilePreference(input) {
  const text = String(input ?? '').trim();
  const match = text.match(PROFILE_UPDATE_RE);
  if (!match) return null;
  const preference = String(match[1] ?? '')
    .replace(/^(?:(?:dans|sur|a|à)\s+)?(?:mon|ma|le|la|ce|cette)?\s*(?:profil|profile)\s+(?:que\s+)?/i, '')
    .replace(/^que\s+/i, '')
    .trim()
    .replace(/[.。]\s*$/, '');
  return preference.length >= 3 ? preference : null;
}

function profilePathForWorkspace(workspacePath) {
  return join(workspacePath, '.wiki', 'profile.md');
}

function formatPreference(preference) {
  const clean = String(preference ?? '').trim();
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function normalizeForCompare(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function insertPreference(content, preference) {
  const line = `- ${formatPreference(preference)}`;
  const normalizedLine = normalizeForCompare(line);
  const hasDuplicate = content
    .split('\n')
    .some((existing) => normalizeForCompare(existing) === normalizedLine);
  if (hasDuplicate) {
    return { content, changed: false, line };
  }

  const heading = '## User Preferences';
  const index = content.indexOf(heading);
  if (index === -1) {
    const next = content.trimEnd();
    return {
      content: `${next}${next ? '\n\n' : ''}${heading}\n\n${line}\n`,
      changed: true,
      line,
    };
  }

  const afterHeading = index + heading.length;
  const nextHeading = content.slice(afterHeading).search(/\n##\s+/);
  if (nextHeading === -1) {
    const prefix = content.slice(0, afterHeading).trimEnd();
    const suffix = content.slice(afterHeading).trim();
    return {
      content: `${prefix}\n\n${suffix ? `${suffix}\n` : ''}${line}\n`,
      changed: true,
      line,
    };
  }

  const insertAt = afterHeading + nextHeading;
  const before = content.slice(0, insertAt).trimEnd();
  const after = content.slice(insertAt).replace(/^\n+/, '\n');
  return {
    content: `${before}\n${line}\n${after}`,
    changed: true,
    line,
  };
}

export async function updateWorkspaceProfilePreference(session, preference) {
  const workspacePath = session?.workspacePath;
  if (!workspacePath) {
    return {
      ok: false,
      message: 'Profil non modifié : aucun workspace chargé. Utilise /use <workspace>.',
    };
  }
  const profilePath = profilePathForWorkspace(workspacePath);
  await mkdir(join(workspacePath, '.wiki'), { recursive: true });
  let before = DEFAULT_PROFILE;
  try {
    before = await readFile(profilePath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const inserted = insertPreference(before, preference);
  if (inserted.changed) {
    await writeFile(profilePath, inserted.content, 'utf8');
  }
  return {
    ok: true,
    changed: inserted.changed,
    preference: inserted.line.replace(/^- /, ''),
    message: inserted.changed
      ? `Profil mis à jour : ${inserted.line.replace(/^- /, '')}`
      : `Profil déjà à jour : ${inserted.line.replace(/^- /, '')}`,
  };
}

export async function handleProfileUpdateRequest(input, { session, messages, onUpdate } = {}) {
  const preference = extractProfilePreference(input);
  if (!preference) return null;
  const targetMessages = messages ?? session?.conversation ?? [];
  targetMessages.push({ role: 'user', content: input });
  try {
    const result = await updateWorkspaceProfilePreference(session, preference);
    targetMessages.push({ role: 'donna', content: result.message });
    onUpdate?.();
    return result;
  } catch (err) {
    const message = `Profil non modifié : ${err instanceof Error ? err.message : String(err)}`;
    targetMessages.push({ role: 'donna', content: message });
    onUpdate?.();
    return { ok: false, message };
  }
}
