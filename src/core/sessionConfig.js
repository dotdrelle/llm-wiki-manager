import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLlmClientFromWikiConfig } from '../agent/llm.js';
import { loadWikircProfile, summarizeWikircConfig } from './wikirc.js';

/*
 The active .wikirc profile is the WORKSPACE's, not one process's. Three
 processes hold a session on the same workspace — the runtime (serve's
 conversations, every run), the ShellUI (its local chat/agent turns) and serve
 itself (its own retrieval and fallback chat) — and each used to keep the
 profile in memory only: a switch in serve never reached the ShellUI, a switch
 in the ShellUI never reached the runtime, and a runtime restart (frequent: it
 relaunches on newer sources) silently went back to `default`.

 The choice now lives in `.wiki/active-profile.json` inside the workspace,
 written by every switch and re-read by `syncSessionWikirc` before each turn
 and run. The same fingerprint also catches an edit of the profile file itself
 (`/config edit`, a hand edit), which used to need a `/use` to take effect.
 */
const ACTIVE_PROFILE_FILE = join('.wiki', 'active-profile.json');

function activeProfilePath(workspacePath) {
  return join(workspacePath, ACTIVE_PROFILE_FILE);
}

export function readActiveProfileName(workspacePath) {
  if (!workspacePath) return null;
  try {
    const record = JSON.parse(readFileSync(activeProfilePath(workspacePath), 'utf8'));
    const name = typeof record?.profile === 'string' ? record.profile.trim() : '';
    return name || null;
  } catch {
    return null;
  }
}

export function writeActiveProfileName(workspacePath, profileName) {
  const path = activeProfilePath(workspacePath);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ profile: profileName, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(temp, path);
}

function profileFingerprint(profileName, profilePath) {
  try {
    const stat = statSync(profilePath);
    return `${profileName}|${profilePath}|${stat.mtimeMs}|${stat.size}`;
  } catch {
    return `${profileName}|${profilePath}|missing`;
  }
}

export function applySessionWikircProfile(session, profileName = 'default', { persist = false } = {}) {
  if (!session.workspacePath) {
    throw new Error('No workspace loaded. Use /use <workspace>.');
  }
  const loaded = loadWikircProfile(session.workspacePath, profileName);
  session.wikirc = {
    profile: loaded.profile.name,
    fileName: loaded.profile.fileName,
    path: loaded.profile.path,
  };
  session.wikircConfig = loaded.config;
  session.language = loaded.config?.language ?? null;
  session.llm = createLlmClientFromWikiConfig(loaded.config);
  session._wikircFingerprint = profileFingerprint(loaded.profile.name, loaded.profile.path);
  if (session.mcp?.production) {
    session.mcp.production.activeConfigPath = loaded.profile.fileName;
  }
  if (persist) writeActiveProfileName(session.workspacePath, loaded.profile.name);
  return {
    summary: summarizeWikircConfig(loaded.profile, loaded.config),
    config: loaded.config,
  };
}

/*
 Brings a session in line with the workspace's active profile: another process
 switched it, or the profile file was edited. Returns what happened so the
 caller can announce it; a profile that can no longer be loaded (deleted file,
 broken YAML) keeps the current client and says why, once per distinct cause.
 */
export function syncSessionWikirc(session) {
  if (!session?.workspacePath || !session.wikirc) return { changed: false };
  const wanted = readActiveProfileName(session.workspacePath) ?? session.wikirc.profile;
  let profilePath = session.wikirc.path;
  if (wanted !== session.wikirc.profile) profilePath = null;
  if (profilePath && profileFingerprint(wanted, profilePath) === session._wikircFingerprint) {
    return { changed: false };
  }
  const previous = session.wikirc.profile;
  try {
    applySessionWikircProfile(session, wanted);
    session._wikircSyncError = null;
    return {
      changed: true,
      previous,
      profile: session.wikirc.profile,
      reason: previous === session.wikirc.profile ? 'edited' : 'switched',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (session._wikircSyncError === message) return { changed: false };
    session._wikircSyncError = message;
    return { changed: false, error: `wikirc profile "${wanted}" could not be loaded (${message}); keeping "${previous}".` };
  }
}

export function wikircSyncNotice(result) {
  if (result?.error) return `config: ${result.error}`;
  if (!result?.changed) return null;
  return result.reason === 'edited'
    ? `config: wikirc profile "${result.profile}" reloaded (file changed)`
    : `config: wikirc profile switched to "${result.profile}" (was "${result.previous}")`;
}
