import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import YAML from 'yaml';

const DEFAULT_WIKIRC = '.wikirc.yaml';

export function listWikircProfiles(workspacePath) {
  if (!workspacePath || !existsSync(workspacePath)) return [];

  return readdirSync(workspacePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name === DEFAULT_WIKIRC || name.startsWith(`${DEFAULT_WIKIRC}.`))
    .sort((a, b) => {
      if (a === DEFAULT_WIKIRC) return -1;
      if (b === DEFAULT_WIKIRC) return 1;
      return a.localeCompare(b);
    })
    .map((fileName) => ({
      name: fileName === DEFAULT_WIKIRC ? 'default' : fileName.slice(`${DEFAULT_WIKIRC}.`.length),
      fileName,
      path: join(workspacePath, fileName),
      default: fileName === DEFAULT_WIKIRC,
    }));
}

export function resolveWikircProfile(workspacePath, profileName = 'default') {
  const profiles = listWikircProfiles(workspacePath);
  const normalized = profileName || 'default';
  const found = profiles.find((profile) => profile.name === normalized || profile.fileName === normalized);
  if (!found) {
    const available = profiles.map((profile) => profile.name).join(', ') || 'aucun';
    throw new Error(`profil wikirc introuvable: ${normalized} (disponibles: ${available})`);
  }
  return found;
}

export function loadWikircProfile(workspacePath, profileName = 'default') {
  const profile = resolveWikircProfile(workspacePath, profileName);
  const config = YAML.parse(readFileSync(profile.path, 'utf8'));
  return { profile, config };
}

export function summarizeWikircConfig(profile, config) {
  return {
    profile: profile.name,
    fileName: basename(profile.path),
    language: config?.language ?? null,
    provider: config?.llm?.provider ?? null,
    model: config?.llm?.model ?? null,
    baseUrl: config?.llm?.baseUrl ?? null,
    hasApiKey: Boolean(config?.llm?.apiKey),
    vectorEnabled: Boolean(config?.retrieval?.vector?.enabled),
    embeddingModel: config?.retrieval?.vector?.embeddingModel ?? null,
  };
}
