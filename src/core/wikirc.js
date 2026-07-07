import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
    const available = profiles.map((profile) => profile.name).join(', ') || 'none';
    throw new Error(`wikirc profile not found: ${normalized} (available: ${available})`);
  }
  return found;
}

export function loadWikircProfile(workspacePath, profileName = 'default') {
  const profile = resolveWikircProfile(workspacePath, profileName);
  const doc = YAML.parseDocument(readFileSync(profile.path, 'utf8'), {
    schema: 'core',
  });
  if (doc.errors.length > 0) {
    throw new Error(`wikirc YAML invalide: ${doc.errors[0].message}`);
  }
  const config = doc.toJSON();
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('wikirc YAML invalide: objet attendu a la racine');
  }
  config.capabilityRouting = normalizeCapabilityRouting(config.capabilityRouting);
  return { profile, config };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCapabilityRouting(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([capability]) => String(capability).trim())
      .map(([capability, routing]) => [
        String(capability).trim(),
        {
          preferredAgents: normalizeAgentList(routing?.preferredAgents),
          fallbackAgents: normalizeAgentList(routing?.fallbackAgents),
          allowedAgents: normalizeAgentList(routing?.allowedAgents),
        },
      ]),
  );
}

function normalizeAgentList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item != null).map((item) => String(item).trim()).filter(Boolean);
}

function setYamlValue(map, key, value) {
  if (isPlainObject(value)) {
    let child = map.get(key, true);
    if (!YAML.isMap(child)) {
      child = new YAML.YAMLMap();
      map.set(key, child);
    }
    mergeYamlMap(child, value);
    return;
  }
  map.set(key, value);
}

function mergeYamlMap(map, patches) {
  for (const [key, value] of Object.entries(patches ?? {})) {
    setYamlValue(map, key, value);
  }
}

function stripCommentedVectorKeys(raw, keys) {
  const keySet = new Set(keys.filter(Boolean));
  if (keySet.size === 0) return raw;

  let inRetrieval = false;
  let retrievalIndent = -1;
  let inVector = false;
  let vectorIndent = -1;

  return raw.split(/\r?\n/).filter((line) => {
    const nonComment = line.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s|$)/);
    if (nonComment) {
      const indent = nonComment[1].length;
      const key = nonComment[2];
      if (inVector && indent <= vectorIndent) inVector = false;
      if (inRetrieval && indent <= retrievalIndent) inRetrieval = false;
      if (!inRetrieval && key === 'retrieval') {
        inRetrieval = true;
        retrievalIndent = indent;
      } else if (inRetrieval && !inVector && indent > retrievalIndent && key === 'vector') {
        inVector = true;
        vectorIndent = indent;
      }
    }

    if (inVector) {
      const commentedKey = line.match(/^\s*#\s*([A-Za-z0-9_-]+):/);
      if (commentedKey && keySet.has(commentedKey[1])) return false;
    }
    return true;
  }).join('\n');
}

export function patchWikircProfile(workspacePath, profileName = 'default', patches = {}) {
  const profile = resolveWikircProfile(workspacePath, profileName);
  const vectorPatch = patches?.retrieval?.vector;
  const commentedVectorKeysToStrip = [
    vectorPatch?.baseUrl ? 'baseUrl' : null,
    vectorPatch?.apiKey ? 'apiKey' : null,
  ];
  const raw = stripCommentedVectorKeys(readFileSync(profile.path, 'utf8'), commentedVectorKeysToStrip);
  const doc = YAML.parseDocument(raw, {
    schema: 'core',
    keepSourceTokens: true,
  });
  if (doc.errors.length > 0) {
    throw new Error(`wikirc YAML invalide: ${doc.errors[0].message}`);
  }
  if (!YAML.isMap(doc.contents)) {
    throw new Error('wikirc YAML invalide: objet attendu a la racine');
  }
  mergeYamlMap(doc.contents, patches);
  writeFileSync(profile.path, doc.toString(), 'utf8');
  return { profile, patches };
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
