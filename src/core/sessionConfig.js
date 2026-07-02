import { createLlmClientFromWikiConfig } from '../agent/llm.js';
import { loadWikircProfile, summarizeWikircConfig } from './wikirc.js';

export function applySessionWikircProfile(session, profileName = 'default') {
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
  if (session.mcp?.production) {
    session.mcp.production.activeConfigPath = loaded.profile.fileName;
  }
  return {
    summary: summarizeWikircConfig(loaded.profile, loaded.config),
    config: loaded.config,
  };
}
