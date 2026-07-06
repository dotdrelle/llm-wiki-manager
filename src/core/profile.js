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
