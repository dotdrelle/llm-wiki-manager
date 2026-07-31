/**
 * Découverte des modèles disponibles, pour alimenter le wizard.
 *
 * Deux chemins, correspondant aux deux valeurs de `llm.provider` :
 *
 * - `openai-compatible` : un serveur unique. L'endpoint et les en-têtes
 *   dépendent du moteur (`engine`), d'où les tables ci-dessous.
 * - `ai-gateway` : un seul chemin, `GET /v1/models`, plus `GET /model/info`
 *   quand il est disponible — c'est lui qui porte le type de chaque modèle
 *   (chat, embedding, rerank) et permet de filtrer les listes du wizard.
 */

const FALLBACK_MODELS = {
  openai: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-7-sonnet-latest'],
  ollama: ['llama3.2', 'qwen2.5', 'mistral', 'nomic-embed-text'],
  vllm: ['Qwen/Qwen2.5-7B-Instruct', 'meta-llama/Llama-3.1-8B-Instruct'],
  mlx: ['mlx-community/Qwen2.5-7B-Instruct-4bit'],
  albert: ['albert-large', 'albert-small'],
  generic: ['gpt-4.1-mini', 'llama3.2'],
};

const FALLBACK_EMBEDDINGS = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
  anthropic: ['text-embedding-3-small'],
  ollama: ['nomic-embed-text', 'mxbai-embed-large'],
  vllm: ['BAAI/bge-m3'],
  mlx: ['BAAI/bge-m3'],
  albert: ['BAAI/bge-m3'],
  generic: ['BAAI/bge-m3', 'text-embedding-3-small', 'nomic-embed-text'],
};

export const PROVIDERS = ['openai-compatible', 'ai-gateway'];

export const ENGINES = [
  'ollama',
  'vllm',
  'mlx',
  'albert',
  'openai',
  'anthropic',
  'generic',
];

/** Moteurs qui exigent une baseUrl explicite — il n'existe pas de défaut sensé. */
const ENGINES_REQUIRING_BASE_URL = new Set(['ollama', 'vllm', 'mlx', 'generic']);

const ENGINE_DEFAULT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  albert: 'https://albert.api.etalab.gouv.fr/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  vllm: 'http://127.0.0.1:8000/v1',
  mlx: 'http://127.0.0.1:8080/v1',
};

export function requiresBaseUrl(provider, engine) {
  if (normalizeProvider(provider) === 'ai-gateway') return true;
  return ENGINES_REQUIRING_BASE_URL.has(normalizeEngine(engine));
}

export function defaultBaseUrl(provider, engine) {
  if (normalizeProvider(provider) === 'ai-gateway') return '';
  return ENGINE_DEFAULT_BASE_URL[normalizeEngine(engine)] ?? '';
}

/** Routage. Tolérant aux libellés du wizard. */
export function normalizeProvider(provider) {
  const value = String(provider ?? '').toLowerCase();
  if (value.includes('gateway')) return 'ai-gateway';
  return 'openai-compatible';
}

/**
 * Libellés du wizard vers moteur. Correspondance **exacte**, pas par sous-chaîne.
 *
 * Une recherche par sous-chaîne était fausse : « Other (generic
 * OpenAI-compatible) » contient « openai », qui était testé avant « generic »
 * — l'option « serveur générique » persistait donc `engine: openai`, avec les
 * contournements inversés. Et aucun libellé ne pouvait plus résoudre vers
 * `generic`, ce qui cassait la présélection à la réouverture du wizard.
 */
const ENGINE_LABELS = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['ollama (local)', 'ollama'],
  ['vllm (local)', 'vllm'],
  ['mlx (local)', 'mlx'],
  ['albert', 'albert'],
  ['other (generic openai-compatible)', 'generic'],
]);

/**
 * Moteur. Accepte les libellés du wizard, les valeurs canoniques, et les
 * anciennes valeurs de `provider` (`openai`, `ollama`, `anthropic`) devenues
 * des moteurs.
 */
export function normalizeEngine(engine) {
  const value = String(engine ?? '').trim().toLowerCase();
  const fromLabel = ENGINE_LABELS.get(value);
  if (fromLabel) return fromLabel;
  if (ENGINES.includes(value)) return value;
  // Repli tolérant, utile pour les valeurs libres ; l'ordre importe donc les
  // moteurs les plus spécifiques passent avant les plus génériques.
  for (const candidate of ENGINES) {
    if (candidate !== 'generic' && value.includes(candidate)) return candidate;
  }
  return 'generic';
}

function fallbackFor(engine, kind) {
  const normalized = normalizeEngine(engine);
  const source = kind === 'embedding' ? FALLBACK_EMBEDDINGS : FALLBACK_MODELS;
  return source[normalized] ?? source.generic;
}

function trimUrl(url) {
  return String(url ?? '').replace(/\/+$/g, '');
}

/**
 * `baseUrl` est écrite avec son suffixe `/v1` dans le wikirc. Les endpoints de
 * listing vivent tantôt sous `/v1` (OpenAI), tantôt à la racine (Ollama,
 * `/model/info` de LiteLLM) — d'où cette racine sans suffixe.
 */
function rootOf(baseUrl) {
  return trimUrl(baseUrl).replace(/\/v1$/, '');
}

function endpointFor(provider, engine, baseUrl) {
  if (normalizeProvider(provider) === 'ai-gateway') {
    return `${rootOf(baseUrl)}/v1/models`;
  }
  const normalized = normalizeEngine(engine);
  if (normalized === 'anthropic') return 'https://api.anthropic.com/v1/models';
  const root = rootOf(baseUrl) || 'https://api.openai.com';
  return normalized === 'ollama' ? `${root}/api/tags` : `${root}/v1/models`;
}

function headersFor(provider, engine, apiKey) {
  if (normalizeProvider(provider) === 'ai-gateway') {
    return { Authorization: `Bearer ${apiKey}` };
  }
  const normalized = normalizeEngine(engine);
  if (normalized === 'ollama') return {};
  if (normalized === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function parseModelNames(provider, engine, payload) {
  const items =
    normalizeProvider(provider) === 'openai-compatible' &&
    normalizeEngine(engine) === 'ollama'
      ? payload?.models
      : payload?.data;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => item?.id ?? item?.name ?? item?.model)
    .filter(Boolean)
    .map(String)
    .sort((a, b) => a.localeCompare(b));
}

async function getJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liste plate des modèles.
 *
 * `options.engine` porte le moteur ; à défaut, le premier argument est
 * réinterprété comme tel, ce qui garde les appels historiques valides.
 */
export async function fetchModels(provider, baseUrl, apiKey, options = {}) {
  const routing = normalizeProvider(provider);
  const normalizedEngine = normalizeEngine(options.engine ?? provider);

  if (routing === 'openai-compatible' && normalizedEngine === 'anthropic') {
    return {
      ok: false,
      models: fallbackFor(normalizedEngine, options.kind),
      source: 'fallback',
      error: 'Anthropic model listing is not supported',
    };
  }

  const timeoutMs = options.timeoutMs ?? 10000;
  try {
    const needsKey = !(routing === 'openai-compatible' && normalizedEngine === 'ollama');
    if (needsKey && !apiKey) {
      throw new Error('API key is required to fetch remote models');
    }
    const payload = await getJson(
      endpointFor(provider, normalizedEngine, baseUrl),
      headersFor(provider, normalizedEngine, apiKey),
      timeoutMs,
    );
    const models = parseModelNames(provider, normalizedEngine, payload);
    if (models.length === 0) throw new Error('No models returned');
    return { ok: true, models, source: 'remote' };
  } catch (err) {
    return {
      ok: false,
      models: fallbackFor(normalizedEngine, options.kind),
      source: 'fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Catalogue typé d'une gateway.
 *
 * Dégradation gracieuse en trois temps — jamais un catch silencieux vers un
 * défaut :
 *
 *   1. `GET /model/info` porte `model_info.mode` : on sait quel modèle est un
 *      chat, un embedding ou un reranker, et le wizard filtre ses listes.
 *   2. `GET /v1/models` ne renvoie qu'une liste plate : les trois listes
 *      reçoivent la même chose, et `typed: false` permet à l'appelant de le
 *      dire à l'utilisateur.
 *   3. Injoignable : listes vides, `error` renseignée. Le wizard garde sa
 *      saisie libre, qui fait foi de toute façon.
 */
export async function fetchGatewayCatalog(baseUrl, apiKey, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const headers = { Authorization: `Bearer ${apiKey}` };

  try {
    const payload = await getJson(`${rootOf(baseUrl)}/model/info`, headers, timeoutMs);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const typed = { chat: [], embedding: [], rerank: [] };
    for (const item of items) {
      const name = item?.model_name ?? item?.id ?? item?.model_info?.id;
      const mode = item?.model_info?.mode;
      if (!name || !mode || !(mode in typed)) continue;
      typed[mode].push(String(name));
    }
    const total = typed.chat.length + typed.embedding.length + typed.rerank.length;
    if (total === 0) throw new Error('No typed models returned by /model/info');
    for (const key of Object.keys(typed)) {
      typed[key] = [...new Set(typed[key])].sort((a, b) => a.localeCompare(b));
    }
    return { ok: true, typed: true, source: 'model-info', ...typed };
  } catch (modelInfoError) {
    const flat = await fetchModels('ai-gateway', baseUrl, apiKey, { timeoutMs });
    if (!flat.ok) {
      return {
        ok: false,
        typed: false,
        source: 'unreachable',
        chat: [],
        embedding: [],
        rerank: [],
        error: flat.error,
      };
    }
    return {
      ok: true,
      typed: false,
      source: 'models',
      chat: flat.models,
      embedding: flat.models,
      rerank: flat.models,
      // Conservée pour l'affichage : elle explique pourquoi les listes ne sont
      // pas filtrées.
      error:
        modelInfoError instanceof Error ? modelInfoError.message : String(modelInfoError),
    };
  }
}

export function fallbackModels(engine, kind) {
  return fallbackFor(engine, kind);
}
