import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlmClientFromWikiConfig } from './llm.js';

function captureFetch(reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => reply };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const reply = { choices: [{ message: { content: 'ok' } }] };
const gateway = {
  provider: 'ai-gateway',
  baseUrl: 'https://gw.example.com/v1',
  apiKey: 'k',
};

test('omits temperature for a gpt-5-class model even when the profile sets one', async () => {
  const { calls, restore } = captureFetch(reply);
  try {
    const client = createLlmClientFromWikiConfig({
      llm: { ...gateway, model: 'openai/gpt-5-mini', temperature: 0.2 },
    });
    await client.complete({ system: 's', input: 'i' });
    assert.equal('temperature' in calls[0].body, false);
  } finally {
    restore();
  }
});

test('keeps the configured temperature for a model that accepts it', async () => {
  const { calls, restore } = captureFetch(reply);
  try {
    const client = createLlmClientFromWikiConfig({
      llm: { ...gateway, model: 'openai/gpt-4.1', temperature: 0.3 },
    });
    await client.complete({ system: 's', input: 'i' });
    assert.equal(calls[0].body.temperature, 0.3);
  } finally {
    restore();
  }
});

test('keeps the 0.2 default when the profile declares no temperature', async () => {
  const { calls, restore } = captureFetch(reply);
  try {
    const client = createLlmClientFromWikiConfig({
      llm: { ...gateway, model: 'openai/gpt-4.1' },
    });
    await client.complete({ system: 's', input: 'i' });
    assert.equal(calls[0].body.temperature, 0.2);
  } finally {
    restore();
  }
});
