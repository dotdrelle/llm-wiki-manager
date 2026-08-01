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

/**
 * Type d'un modèle, quand la réponse le porte.
 *
 * `/v1/models` d'OpenAI ne type rien (`object: "model"` partout) — d'où le
 * repli non typé. Mais plusieurs serveurs OpenAI-compatibles ajoutent un
 * champ : Albert annonce `text-generation`, `text-embeddings-inference` ou
 * `text-classification` (son reranker), LiteLLM porte `model_info.mode`. Les
 * ignorer forçait le wizard à proposer les modèles de chat pour l'étape
 * embeddings — sur Albert, aucune suggestion ne pouvait correspondre.
 *
 * Un indice non reconnu (`automatic-speech-recognition`) rend `null` : le
 * modèle est simplement absent des trois listes.
 */
export function classifyModelEntry(item) {
  const hints = [
    item?.model_info?.mode,
    item?.mode,
    item?.type,
    item?.task,
    item?.object,
    ...(Array.isArray(item?.capabilities) ? item.capabilities : []),
  ]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase());

  for (const hint of hints) {
    if (hint.includes('embed')) return 'embedding';
    // Albert expose son reranker en `text-classification`.
    if (hint.includes('rerank') || hint.includes('classification')) return 'rerank';
    if (hint.includes('chat') || hint.includes('generation') || hint.includes('completion')) {
      return 'chat';
    }
  }
  return null;
}

function itemsOf(provider, engine, payload) {
  return normalizeProvider(provider) === 'openai-compatible' && normalizeEngine(engine) === 'ollama'
    ? payload?.models
    : payload?.data;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function parseModelNames(provider, engine, payload) {
  const items = itemsOf(provider, engine, payload);
  if (!Array.isArray(items)) return [];
  return sortedUnique(
    items.map((item) => item?.id ?? item?.name ?? item?.model).filter(Boolean).map(String),
  );
}

/**
 * Délai de découverte du wizard.
 *
 * Un `/v1/models` qui répond le fait en quelques dizaines de millisecondes :
 * ce délai n'est jamais payé par un endpoint sain, il ne borne que les pannes
 * silencieuses (proxy qui avale la connexion, port filtré). Il peut donc
 * rester confortable — la découverte est lancée en tâche de fond, aucune
 * étape du wizard ne l'attend.
 */
export const DISCOVERY_TIMEOUT_MS = 8000;

/** Codes TLS qui désignent une CA privée ou un proxy qui intercepte. */
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function httpStatusHint(status, url) {
  if (status === 401) return `HTTP 401 — API key rejected by ${hostOf(url)}`;
  if (status === 403) {
    return `HTTP 403 — key accepted but access to the model catalog is denied`;
  }
  if (status === 404) return `HTTP 404 — no model catalog exposed at ${url}`;
  if (status === 407) {
    return `HTTP 407 — the HTTP proxy requires authentication (check HTTPS_PROXY credentials)`;
  }
  if (status >= 500) return `HTTP ${status} — the server failed to answer ${url}`;
  return `HTTP ${status} on ${url}`;
}

/**
 * Message actionnable pour un échec réseau.
 *
 * Le message brut de `fetch` ("fetch failed") ne dit rien : la cause utile est
 * dans `err.cause.code`. On la traduit en une phrase qui nomme la manœuvre —
 * proxy, CA privée, port fermé, DNS — parce que c'est exactement ce que
 * l'opérateur doit corriger, et qu'il ne le devinera pas depuis le wizard.
 */
export function describeFetchError(err, { url, timeoutMs } = {}) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    // Le délai en millisecondes est un détail d'implémentation : ce qui aide
    // l'opérateur, c'est l'hôte qui n'a pas répondu et les causes probables.
    return `${hostOf(url)} did not answer in time — server unreachable, or blocked by a proxy or firewall`;
  }
  const code = err?.cause?.code ?? err?.code ?? null;
  if (code && TLS_ERROR_CODES.has(code)) {
    return `TLS certificate rejected (${code}) — private CA or intercepting proxy; relaunch with wiki-manager --cacert <file.pem>`;
  }
  if (code === 'ECONNREFUSED') {
    return `connection refused (ECONNREFUSED) by ${hostOf(url)} — nothing is listening on this host/port`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `host not found (${code}): ${hostOf(url)} — check the URL, DNS, or that the proxy resolves it`;
  }
  if (code === 'ETIMEDOUT') {
    return `connection timed out (ETIMEDOUT) to ${hostOf(url)} — usually a firewall dropping the packets`;
  }
  if (code === 'ECONNRESET' || code === 'EPROTO') {
    return `connection reset (${code}) by ${hostOf(url)} — often a proxy intercepting TLS, or http:// used on an https:// endpoint`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return code ? `${message} (${code})` : message;
}

/**
 * État du transport local, affiché à côté d'une erreur de découverte.
 *
 * Un proxy déclaré mais non activé (`NODE_USE_ENV_PROXY` absent) est la panne
 * la plus fréquente en entreprise, et elle est invisible sans ce rappel.
 */
export function transportSummary(env = process.env) {
  const proxy = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? null;
  const parts = [];
  if (proxy) {
    parts.push(
      env.NODE_USE_ENV_PROXY === '1'
        ? `proxy ${proxy}`
        : `proxy ${proxy} (NODE_USE_ENV_PROXY not set: it is NOT used)`,
    );
  } else {
    parts.push('direct connection (no HTTP(S)_PROXY)');
  }
  const cacert = env.WIKI_MANAGER_CACERT_PATH ?? env.NODE_EXTRA_CA_CERTS ?? null;
  parts.push(cacert ? `CA ${cacert}` : 'CA system trust store');
  return parts.join(' · ');
}

async function getJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(httpStatusHint(response.status, url));
    return await response.json();
  } catch (err) {
    if (err instanceof Error && /^HTTP \d/.test(err.message)) throw err;
    throw new Error(describeFetchError(err, { url, timeoutMs }));
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

  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
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
    // `raw` rend les entrées brutes, seules porteuses des indices de type que
    // `fetchServerCatalog` exploite. Absentes par défaut : la forme historique
    // de ce retour est {ok, models, source}.
    return options.raw
      ? { ok: true, models, source: 'remote', items: itemsOf(provider, normalizedEngine, payload) ?? [] }
      : { ok: true, models, source: 'remote' };
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
 *
 * Les deux appels partent **en parallèle**, et le résultat est livré en deux
 * temps : `options.onPartial` reçoit la liste plate de `/v1/models` dès
 * qu'elle arrive — c'est la requête rapide, et elle suffit à choisir un
 * modèle — pendant que `/model/info`, plus lourd côté gateway, continue.
 * La promesse résout ensuite avec le catalogue typé s'il aboutit. L'opérateur
 * a donc une liste utilisable immédiatement, qui se raffine sous ses yeux.
 */
export async function fetchGatewayCatalog(baseUrl, apiKey, options = {}) {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const onPartial = typeof options.onPartial === 'function' ? options.onPartial : null;

  const flatPromise = fetchModels('ai-gateway', baseUrl, apiKey, { timeoutMs });
  // Sans ce no-op, un rejet arrivant avant son `await` remonterait en
  // unhandledRejection quand le chemin typé réussit.
  flatPromise.catch(() => {});

  const flatResult = (flat, error) => ({
    ok: true,
    typed: false,
    source: 'models',
    chat: flat.models,
    embedding: flat.models,
    rerank: flat.models,
    // Conservée pour l'affichage : elle explique pourquoi les listes ne sont
    // pas filtrées.
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  });

  let settled = false;
  if (onPartial) {
    flatPromise
      .then((flat) => {
        if (settled || !flat.ok) return;
        onPartial(flatResult(flat));
      })
      .catch(() => {});
  }

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
    settled = true;
    return { ok: true, typed: true, source: 'model-info', ...typed };
  } catch (modelInfoError) {
    const flat = await flatPromise;
    settled = true;
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
    return flatResult(flat, modelInfoError);
  }
}

/**
 * Catalogue d'un serveur unique, typé quand le serveur le permet.
 *
 * Même forme de retour que `fetchGatewayCatalog`, pour que le wizard n'ait
 * qu'un seul objet à afficher. Un seul appel : chat et embeddings partagent
 * l'endpoint, les interroger séparément revenait à poser deux fois la même
 * question.
 */
export async function fetchServerCatalog(provider, baseUrl, apiKey, options = {}) {
  const engine = options.engine ?? provider;
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const flat = await fetchModels(provider, baseUrl, apiKey, { engine, timeoutMs, raw: true });
  if (!flat.ok) {
    return { ok: false, typed: false, source: 'unreachable', chat: [], embedding: [], rerank: [], error: flat.error };
  }

  const typed = { chat: [], embedding: [], rerank: [] };
  for (const item of flat.items ?? []) {
    const name = item?.id ?? item?.name ?? item?.model;
    const kind = classifyModelEntry(item);
    if (name && kind) typed[kind].push(String(name));
  }
  // Typage partiel accepté : un serveur peut n'annoncer que ses embeddings.
  // Les listes vides retombent sur la liste complète plutôt que de rester
  // vides — mieux vaut trop proposer que rien.
  const classified = typed.chat.length + typed.embedding.length + typed.rerank.length;
  if (classified === 0) {
    return { ok: true, typed: false, source: 'models', chat: flat.models, embedding: flat.models, rerank: flat.models };
  }
  return {
    ok: true,
    typed: true,
    source: 'models',
    chat: typed.chat.length ? sortedUnique(typed.chat) : flat.models,
    embedding: typed.embedding.length ? sortedUnique(typed.embedding) : flat.models,
    rerank: typed.rerank.length ? sortedUnique(typed.rerank) : flat.models,
  };
}

export function fallbackModels(engine, kind) {
  return fallbackFor(engine, kind);
}
