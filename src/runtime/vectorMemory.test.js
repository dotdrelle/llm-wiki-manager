import test from 'node:test';
import assert from 'node:assert/strict';
import { embedMemoryTexts } from './vectorMemory.js';

test('embeddings call the workspace-configured endpoint without leaking the key', async () => {
  let request;
  const vectors = await embedMemoryTexts(['query'], {
    enabled: true, baseUrl: 'http://embeddings.example/v1', embeddingModel: 'bge-m3', apiKey: 'secret',
  }, { fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: Array(8).fill(0.25) }] }) };
  } });
  assert.equal(request.url, 'http://embeddings.example/v1/embeddings');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'bge-m3', input: ['query'] });
  assert.equal(vectors[0].length, 8);
});

test('embeddings refuse a malformed vector endpoint without echoing its value', async () => {
  await assert.rejects(embedMemoryTexts(['x'], { enabled: true, baseUrl: 'not a url', embeddingModel: 'm' }),
    (error) => error.message.includes('invalid embedding endpoint') && !error.message.includes('not a url'));
});
