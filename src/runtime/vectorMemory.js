/** Small OpenAI-compatible embeddings adapter; keys/URLs are never returned in errors. */
export async function embedMemoryTexts(texts, vectorConfig, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const items = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? '').slice(0, 1200));
  const config = vectorConfig ?? {};
  if (!config.enabled || !config.baseUrl || !config.embeddingModel || items.length === 0) return null;
  let endpoint;
  try {
    const base = new URL(String(config.baseUrl));
    base.username = '';
    base.password = '';
    base.search = '';
    base.hash = '';
    const path = base.pathname.replace(/\/+$/, '');
    base.pathname = path.endsWith('/embeddings') ? path : `${path}${path.endsWith('/v1') ? '' : '/v1'}/embeddings`;
    endpoint = base;
  } catch {
    throw new Error('memory.vector-unavailable: invalid embedding endpoint configuration');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetchImpl(endpoint, { method: 'POST', headers,
      body: JSON.stringify({ model: config.embeddingModel, input: items }), signal: controller.signal });
    if (!response.ok) throw new Error(`embedding service returned HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const vectors = rows.map((row) => row?.embedding);
    if (vectors.length !== items.length || vectors.some((vector) => !Array.isArray(vector) || vector.length < 8 || vector.some((n) => !Number.isFinite(n)))) {
      throw new Error('embedding service returned an invalid vector response');
    }
    return vectors;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('memory.vector-unavailable: embedding request timed out');
    throw new Error(`memory.vector-unavailable: ${error instanceof Error ? error.message : 'embedding request failed'}`);
  } finally {
    clearTimeout(timer);
  }
}
