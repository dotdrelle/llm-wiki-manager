import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fallbackModels,
  fetchGatewayCatalog,
  fetchModels,
  requiresBaseUrl,
} from './modelFetch.js';

test('fetchModels returns remote OpenAI-compatible model ids', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'b-model' }, { id: 'a-model' }] }),
  });
  try {
    const result = await fetchModels('openai', 'http://models.local', 'key', { timeoutMs: 100 });
    assert.deepEqual(result, { ok: true, models: ['a-model', 'b-model'], source: 'remote' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchModels falls back on invalid remote response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  });
  try {
    const result = await fetchModels('openai', 'http://models.local', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.source, 'fallback');
    assert.ok(result.models.includes('gpt-5.4-mini'));
    assert.match(result.error, /No models returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallbackModels leaves custom-model to the wizard append action', () => {
  assert.deepEqual(fallbackModels('generic'), ['gpt-4.1-mini', 'llama3.2']);
});

test('fetchGatewayCatalog types models from /model/info', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://gw:4000/model/info');
    return {
      ok: true,
      json: async () => ({
        data: [
          { model_name: 'anthropic/claude-sonnet-4-5', model_info: { mode: 'chat' } },
          { model_name: 'infinity/bge-m3', model_info: { mode: 'embedding' } },
          { model_name: 'infinity/bge-reranker', model_info: { mode: 'rerank' } },
          { model_name: 'dalle', model_info: { mode: 'image_generation' } },
        ],
      }),
    };
  };
  try {
    const result = await fetchGatewayCatalog('http://gw:4000/v1', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.typed, true);
    assert.deepEqual(result.chat, ['anthropic/claude-sonnet-4-5']);
    assert.deepEqual(result.embedding, ['infinity/bge-m3']);
    assert.deepEqual(result.rerank, ['infinity/bge-reranker']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGatewayCatalog degrades to an untyped /v1/models list', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/model/info')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ data: [{ id: 'b' }, { id: 'a' }] }) };
  };
  try {
    const result = await fetchGatewayCatalog('http://gw:4000/v1', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.typed, false);
    // Non typé : les trois listes reçoivent la même chose, à charge du wizard
    // de le signaler.
    assert.deepEqual(result.chat, ['a', 'b']);
    assert.deepEqual(result.embedding, ['a', 'b']);
    assert.deepEqual(result.rerank, ['a', 'b']);
    assert.match(result.error, /HTTP 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGatewayCatalog reports an unreachable gateway without inventing models', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const result = await fetchGatewayCatalog('http://gw:4000/v1', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.source, 'unreachable');
    assert.deepEqual(result.chat, []);
    assert.match(result.error, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requiresBaseUrl follows the engine, and the gateway always needs one', () => {
  assert.equal(requiresBaseUrl('openai-compatible', 'ollama'), true);
  assert.equal(requiresBaseUrl('openai-compatible', 'openai'), false);
  assert.equal(requiresBaseUrl('openai-compatible', 'anthropic'), false);
  assert.equal(requiresBaseUrl('ai-gateway', 'openai'), true);
});
