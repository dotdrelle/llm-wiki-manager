const FALLBACK_MODELS = {
  openai: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-7-sonnet-latest'],
  ollama: ['llama3.2', 'qwen2.5', 'mistral', 'nomic-embed-text'],
  'openai-compatible': ['gpt-4.1-mini', 'llama3.2'],
  other: ['gpt-4.1-mini', 'llama3.2'],
};

const FALLBACK_EMBEDDINGS = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
  anthropic: ['text-embedding-3-small'],
  ollama: ['nomic-embed-text', 'mxbai-embed-large'],
  'openai-compatible': ['BAAI/bge-m3', 'text-embedding-3-small', 'nomic-embed-text'],
  other: ['text-embedding-3-small', 'nomic-embed-text'],
};

export function normalizeProvider(provider) {
  const value = String(provider ?? '').toLowerCase();
  if (value.includes('compatible') || value.includes('other')) return 'openai-compatible';
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('ollama')) return 'ollama';
  if (value.includes('openai')) return 'openai';
  return 'openai-compatible';
}

function fallbackFor(provider, kind) {
  const normalized = normalizeProvider(provider);
  const source = kind === 'embedding' ? FALLBACK_EMBEDDINGS : FALLBACK_MODELS;
  return source[normalized] ?? source.other;
}

function endpointFor(provider, baseUrl) {
  const normalized = normalizeProvider(provider);
  if (normalized === 'anthropic') return 'https://api.anthropic.com/v1/models';
  const root = String(baseUrl || (normalized === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com')).replace(/\/+$/g, '');
  return normalized === 'ollama' ? `${root}/api/tags` : `${root}/v1/models`;
}

function headersFor(provider, apiKey) {
  const normalized = normalizeProvider(provider);
  if (normalized === 'ollama') return {};
  if (normalized === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function parseModelNames(provider, payload) {
  const normalized = normalizeProvider(provider);
  const items = normalized === 'ollama' ? payload?.models : payload?.data;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => item?.id ?? item?.name ?? item?.model)
    .filter(Boolean)
    .map(String)
    .sort((a, b) => a.localeCompare(b));
}

export async function fetchModels(provider, baseUrl, apiKey, options = {}) {
  const normalized = normalizeProvider(provider);
  if (normalized === 'anthropic') {
    return { ok: false, models: fallbackFor(normalized, options.kind), source: 'fallback', error: 'Anthropic model listing is not supported' };
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (normalized !== 'ollama' && !apiKey) {
      throw new Error('API key is required to fetch remote models');
    }
    const response = await fetch(endpointFor(normalized, baseUrl), {
      headers: headersFor(normalized, apiKey),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = parseModelNames(normalized, payload);
    if (models.length === 0) throw new Error('No models returned');
    return { ok: true, models, source: 'remote' };
  } catch (err) {
    return {
      ok: false,
      models: fallbackFor(normalized, options.kind),
      source: 'fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function fallbackModels(provider, kind) {
  return fallbackFor(provider, kind);
}
