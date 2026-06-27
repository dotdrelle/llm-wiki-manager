import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackModels, fetchModels } from './modelFetch.js';

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
  assert.deepEqual(fallbackModels('openai-compatible'), ['gpt-4.1-mini', 'llama3.2']);
});
