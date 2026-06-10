import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool } from './mcp.js';

test('callMcpTool injects active configPath for production_start_job', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
    };
  };

  try {
    await callMcpTool(
      {
        production: {
          status: 'connected',
          url: 'http://127.0.0.1:3000/mcp/',
          token: 'token',
          activeConfigPath: '.wikirc.yaml.openai',
        },
      },
      'production',
      'production_start_job',
      { type: 'doctor' },
    );

    assert.equal(requestBody.method, 'tools/call');
    assert.equal(requestBody.params.name, 'production_start_job');
    assert.deepEqual(requestBody.params.arguments, {
      type: 'doctor',
      configPath: '.wikirc.yaml.openai',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callMcpTool keeps explicit production configPath', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
    };
  };

  try {
    await callMcpTool(
      {
        production: {
          status: 'connected',
          url: 'http://127.0.0.1:3000/mcp/',
          token: 'token',
          activeConfigPath: '.wikirc.yaml.openai',
        },
      },
      'production',
      'production_start_job',
      { type: 'doctor', configPath: '.wikirc.yaml.claude' },
    );

    assert.equal(requestBody.params.arguments.configPath, '.wikirc.yaml.claude');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
