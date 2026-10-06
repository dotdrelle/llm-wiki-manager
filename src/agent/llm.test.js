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

test('omits temperature for gpt-6-luna behind the gateway', async () => {
  const { calls, restore } = captureFetch(reply);
  try {
    const client = createLlmClientFromWikiConfig({
      llm: { ...gateway, model: 'gpt-6-luna', temperature: 0.1 },
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

test('sends tool_choice auto instead of a forced tool to a model measured to refuse it', async () => {
  const { calls, restore } = captureFetch(reply);
  try {
    const client = createLlmClientFromWikiConfig({
      llm: {
        ...gateway,
        model: 'deepseek-v4-flash',
        capabilities: { model: 'deepseek-v4-flash', thinking: true, toolChoice: 'auto' },
      },
    });
    const tools = [{ type: 'function', function: { name: 'runtime__delegate', parameters: { type: 'object' } } }];
    await client.completeWithTools({ system: 's', tools, toolChoice: { type: 'function', function: { name: 'runtime__delegate' } } });
    assert.equal(calls[0].body.tool_choice, 'auto');
  } finally {
    restore();
  }
});

test('sends the configured reasoning_effort, and drops it once measured as refused', async () => {
  const { calls, restore } = captureFetch(reply);
  try {
    const llm = { ...gateway, model: 'gpt-6-luna', reasoningEffort: 'none' };
    await createLlmClientFromWikiConfig({ llm }).complete({ system: 's', input: 'i' });
    assert.equal(calls[0].body.reasoning_effort, 'none');
    await createLlmClientFromWikiConfig({
      llm: { ...llm, capabilities: { model: 'gpt-6-luna', reasoningEffort: false } },
    }).complete({ system: 's', input: 'i' });
    assert.equal('reasoning_effort' in calls[1].body, false);
  } finally {
    restore();
  }
});
