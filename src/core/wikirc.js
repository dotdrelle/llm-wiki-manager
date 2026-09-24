import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import YAML from 'yaml';
import { supportsTemperature } from './llmCapabilities.js';

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
    engine: config?.llm?.engine ?? null,
    model: config?.llm?.model ?? null,
    baseUrl: config?.llm?.baseUrl ?? null,
    temperature: typeof config?.llm?.temperature === 'number' ? config.llm.temperature : null,
    hasApiKey: Boolean(config?.llm?.apiKey),
    vectorEnabled: Boolean(config?.retrieval?.vector?.enabled),
    embeddingModel: config?.retrieval?.vector?.embeddingModel ?? null,
  };
}

// The manager parses `.wikirc.yaml` raw (no zod defaults), so `engine` and
// `temperature` can be absent even though the engine resolves defaults. The
// manager's own client falls back to 0.2 when temperature is missing; describe
// what Donna actually runs with, not a guess.
const MANAGER_DEFAULT_TEMPERATURE = 0.2;

/**
 * The base URL as it may be shown to a MODEL. A `baseUrl` can carry a secret of
 * its own — `https://user:token@host/v1`, or a gateway key in the query string
 * (`?api-key=…`) — and the system prompt is repeated in answers, persisted with
 * the conversation, and sent onward by an AI gateway. Keep scheme, host, port
 * and path; drop userinfo, query and fragment, and say so. An unparseable value
 * is withheld whole rather than echoed.
 */
export function promptSafeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return 'unset';
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return '(withheld: not a parseable URL)';
  }
  const withheld = [];
  if (url.username || url.password) withheld.push('credentials');
  if (url.search) withheld.push('query');
  if (url.hash) withheld.push('fragment');
  const safe = `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  return withheld.length ? `${safe} (${withheld.join(', ')} withheld)` : safe;
}

/**
 * One-line description of the ACTIVE LLM configuration, injected into Donna's
 * system prompt. She used to answer "what is your LLM config?" from memory
 * (reporting "GPT-4") because no builder ever handed her these values, in
 * direct violation of the prompt's own "config facts are never answered from
 * memory" rule.
 */
export function formatLlmConfigFact(config, profile) {
  const llm = config?.llm ?? {};
  const provider = llm.provider ?? 'unset';
  const engine = llm.engine
    ?? (provider === 'ai-gateway' ? 'per-model (routed by the gateway)' : 'unspecified');
  const model = llm.model ?? 'unset';
  const baseUrl = promptSafeBaseUrl(llm.baseUrl);
  // A gpt-5-class model refuses `temperature`: the manager omits it, so report
  // the truth rather than the fallback it would have sent otherwise.
  const temperature = !supportsTemperature(llm)
    ? 'not sent (model refuses it)'
    : typeof llm.temperature === 'number'
      ? llm.temperature
      : MANAGER_DEFAULT_TEMPERATURE;
  const profileName = typeof profile === 'string' ? profile : profile?.name;
  return [
    `Active LLM configuration (what YOU run on — answer questions about your own config from here, never from memory): provider=${provider}, engine=${engine}, model=${model}, baseUrl=${baseUrl}, temperature=${temperature}${profileName ? `, .wikirc profile=${profileName}` : ''}.`,
    'The vector/embedding model is configured separately and may differ from this chat model.',
  ].join(' ');
}
