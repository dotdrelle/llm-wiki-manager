/**
 * Discovery of the available models, to feed the wizard.
 *
 * Two paths, matching the two values of `llm.provider`:
 *
 * - `openai-compatible`: a single server. The endpoint and headers
 *   depend on the engine (`engine`), hence the tables below.
 * - `ai-gateway`: a single path, `GET /v1/models`, plus `GET /model/info`
 *   when it is available — it is the one that carries each model's type
 *   (chat, embedding, rerank) and allows the wizard's lists to be filtered.
 */

const FALLBACK_MODELS = {
  openai: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  ollama: ['llama3.2', 'qwen2.5', 'mistral', 'nomic-embed-text'],
  vllm: ['Qwen/Qwen2.5-7B-Instruct', 'meta-llama/Llama-3.1-8B-Instruct'],
  mlx: ['mlx-community/Qwen2.5-7B-Instruct-4bit'],
  albert: ['albert-large', 'albert-small'],
  generic: ['gpt-4.1-mini', 'llama3.2'],
};

const FALLBACK_EMBEDDINGS = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
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
  'generic',
];

/** Engines that require an explicit baseUrl — there is no sensible default. */
const ENGINES_REQUIRING_BASE_URL = new Set(['ollama', 'vllm', 'mlx', 'generic']);

const ENGINE_DEFAULT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
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

/** Routing. Tolerant of the wizard's labels. */
export function normalizeProvider(provider) {
  const value = String(provider ?? '').toLowerCase();
  if (value.includes('gateway')) return 'ai-gateway';
  return 'openai-compatible';
}

/**
 * Wizard labels to engine. **Exact** match, not by substring.
 *
 * A substring search was wrong: "Other (generic
 * OpenAI-compatible)" contains "openai", which was tested before "generic"
 * — the "generic server" option therefore persisted `engine: openai`, with the
 * workarounds inverted. And no label could resolve to
 * `generic` any more, which broke preselection when the wizard was reopened.
 */
const ENGINE_LABELS = new Map([
  ['openai', 'openai'],
  ['ollama (local)', 'ollama'],
  ['vllm (local)', 'vllm'],
  ['mlx (local)', 'mlx'],
  ['albert', 'albert'],
  ['other (generic openai-compatible)', 'generic'],
]);

/**
 * Engine. Accepts the wizard's labels, the canonical values, and the
 * old `provider` values (`openai`, `ollama`) that became engines.
 * The former `anthropic` engine, removed from the config, falls back to `generic`.
 */
export function normalizeEngine(engine) {
  const value = String(engine ?? '').trim().toLowerCase();
  const fromLabel = ENGINE_LABELS.get(value);
  if (fromLabel) return fromLabel;
  if (ENGINES.includes(value)) return value;
  // Tolerant fallback, useful for free-form values; order therefore matters:
  // the most specific engines come before the most generic ones.
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
 * `baseUrl` is written with its `/v1` suffix in the wikirc. The listing
 * endpoints live sometimes under `/v1` (OpenAI), sometimes at the root (Ollama,
 * LiteLLM's `/model/info`) — hence this root without a suffix.
 */
function rootOf(baseUrl) {
  return trimUrl(baseUrl).replace(/\/v1$/, '');
}

function endpointFor(provider, engine, baseUrl) {
  if (normalizeProvider(provider) === 'ai-gateway') {
    return `${rootOf(baseUrl)}/v1/models`;
  }
  const normalized = normalizeEngine(engine);
  const root = rootOf(baseUrl) || 'https://api.openai.com';
  return normalized === 'ollama' ? `${root}/api/tags` : `${root}/v1/models`;
}

function headersFor(provider, engine, apiKey) {
  if (normalizeProvider(provider) === 'ai-gateway') {
    return { Authorization: `Bearer ${apiKey}` };
  }
  const normalized = normalizeEngine(engine);
  if (normalized === 'ollama') return {};
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * A model's type, when the response carries it.
 *
 * OpenAI's `/v1/models` types nothing (`object: "model"` everywhere) — hence the
 * untyped fallback. But several OpenAI-compatible servers add a
 * field: Albert announces `text-generation`, `text-embeddings-inference` or
 * `text-classification` (its reranker), LiteLLM carries `model_info.mode`.
 * Ignoring them forced the wizard to offer the chat models for the
 * embeddings step — on Albert, no suggestion could match.
 *
 * An unrecognized hint (`automatic-speech-recognition`) returns `null`: the
 * model is simply absent from the three lists.
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
    // Albert exposes its reranker as `text-classification`.
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
 * Wizard discovery timeout.
 *
 * A `/v1/models` that answers does so in a few tens of milliseconds:
 * this timeout is never paid by a healthy endpoint, it only bounds silent
 * failures (a proxy swallowing the connection, a filtered port). It can therefore
 * stay comfortable — discovery is launched as a background task, no
 * wizard step waits for it.
 */
export const DISCOVERY_TIMEOUT_MS = 8000;

/** TLS codes that designate a private CA or an intercepting proxy. */
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
 * Actionable message for a network failure.
 *
 * The raw `fetch` message ("fetch failed") says nothing: the useful cause is
 * in `err.cause.code`. It is translated into a sentence that names the maneuver —
 * proxy, private CA, closed port, DNS — because that is exactly what
 * the operator must fix, and they will not guess it from the wizard.
 */
export function describeFetchError(err, { url, timeoutMs } = {}) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    // The delay in milliseconds is an implementation detail: what helps
    // the operator is the host that did not answer and the likely causes.
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
 * Local transport state, displayed next to a discovery error.
 *
 * A declared but inactive proxy (`NODE_USE_ENV_PROXY` absent) is the most
 * frequent failure in the enterprise, and it is invisible without this reminder.
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
 * Flat list of the models.
 *
 * `options.engine` carries the engine; failing that, the first argument is
 * reinterpreted as one, which keeps historical calls valid.
 */
export async function fetchModels(provider, baseUrl, apiKey, options = {}) {
  const routing = normalizeProvider(provider);
  const normalizedEngine = normalizeEngine(options.engine ?? provider);

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
    // `raw` returns the raw entries, the only ones carrying the type hints that
    // `fetchServerCatalog` exploits. Absent by default: the historical shape
    // of this return is {ok, models, source}.
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
 * Typed catalogue of a gateway.
 *
 * Graceful three-step degradation — never a silent catch toward a
 * default:
 *
 *   1. `GET /model/info` carries `model_info.mode`: we know which model is a
 *      chat, an embedding or a reranker, and the wizard filters its lists.
 *   2. `GET /v1/models` returns only a flat list: the three lists
 *      receive the same thing, and `typed: false` lets the caller
 *      tell the user.
 *   3. Unreachable: empty lists, `error` filled in. The wizard keeps its
 *      free-form input, which prevails anyway.
 *
 * The two calls start **in parallel**, and the result is delivered in two
 * stages: `options.onPartial` receives the flat list from `/v1/models` as soon
 * as it arrives — it is the fast request, and it is enough to choose a
 * model — while `/model/info`, heavier on the gateway side, continues.
 * The promise then resolves with the typed catalogue if it succeeds. The operator
 * therefore has a usable list immediately, which refines itself before their eyes.
 */
export async function fetchGatewayCatalog(baseUrl, apiKey, options = {}) {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const onPartial = typeof options.onPartial === 'function' ? options.onPartial : null;

  const flatPromise = fetchModels('ai-gateway', baseUrl, apiKey, { timeoutMs });
  // Without this no-op, a rejection arriving before its `await` would surface as
  // an unhandledRejection when the typed path succeeds.
  flatPromise.catch(() => {});

  const flatResult = (flat, error) => ({
    ok: true,
    typed: false,
    source: 'models',
    chat: flat.models,
    embedding: flat.models,
    rerank: flat.models,
    // Kept for display: it explains why the lists are not
    // filtered.
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
 * Catalogue of a single server, typed when the server allows it.
 *
 * Same return shape as `fetchGatewayCatalog`, so the wizard has
 * only one object to display. A single call: chat and embeddings share
 * the endpoint, querying them separately amounted to asking the same
 * question twice.
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
  // Partial typing accepted: a server may announce only its embeddings.
  // Empty lists fall back to the full list rather than staying
  // empty — better to offer too much than nothing.
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
