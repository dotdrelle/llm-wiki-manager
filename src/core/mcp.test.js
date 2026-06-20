import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildMcpStatus, callMcpTool } from './mcp.js';

test('buildMcpStatus reads external MCP endpoints from mcp.endpoints.json', async () => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-mcp-endpoints-'));
  await writeFile(
    path.join(root, 'mcp.endpoints.json'),
    JSON.stringify({
      mcpServers: {
        external: {
          url: 'http://127.0.0.1:9999/mcp/',
          headers: {
            'x-api-key': 'secret',
            Authorization: 'Bearer token',
          },
        },
      },
    }),
    'utf8',
  );

  try {
    process.chdir(root);
    const status = buildMcpStatus({ workspaceEnv: {} });
    assert.equal(status.external.url, 'http://127.0.0.1:9999/mcp/');
    assert.deepEqual(status.external.headers, {
      'x-api-key': 'secret',
      authorization: 'Bearer token',
    });
    assert.equal(status.external.external, true);
    assert.equal(status.cme, undefined);
  } finally {
    process.chdir(originalCwd);
  }
});

test('buildMcpStatus interpolates external endpoints from manager .env', async () => {
  const originalCwd = process.cwd();
  const originalToken = process.env.TEST_EXTERNAL_TOKEN;
  const originalPort = process.env.TEST_EXTERNAL_PORT;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-mcp-env-'));
  await writeFile(
    path.join(root, '.env'),
    [
      'TEST_EXTERNAL_TOKEN=from-env-file',
      'TEST_EXTERNAL_PORT=4567',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'mcp.endpoints.json'),
    JSON.stringify({
      mcpServers: {
        external: {
          url: 'http://host.docker.internal:${TEST_EXTERNAL_PORT:-9999}/mcp/',
          headers: {
            Authorization: 'Bearer ${TEST_EXTERNAL_TOKEN}',
          },
        },
      },
    }),
    'utf8',
  );
  delete process.env.TEST_EXTERNAL_TOKEN;
  delete process.env.TEST_EXTERNAL_PORT;

  try {
    process.chdir(root);
    const status = buildMcpStatus({ workspaceEnv: {} });
    assert.equal(status.external.url, 'http://localhost:4567/mcp/');
    assert.equal(status.external.configuredUrl, 'http://host.docker.internal:4567/mcp/');
    assert.deepEqual(status.external.headers, {
      authorization: 'Bearer from-env-file',
    });
  } finally {
    process.chdir(originalCwd);
    if (originalToken === undefined) delete process.env.TEST_EXTERNAL_TOKEN;
    else process.env.TEST_EXTERNAL_TOKEN = originalToken;
    if (originalPort === undefined) delete process.env.TEST_EXTERNAL_PORT;
    else process.env.TEST_EXTERNAL_PORT = originalPort;
  }
});

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

test('callMcpTool sends configured endpoint headers', async () => {
  const originalFetch = globalThis.fetch;
  let requestHeaders = null;
  globalThis.fetch = async (_url, init) => {
    requestHeaders = init.headers;
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
        external: {
          status: 'connected',
          url: 'http://127.0.0.1:9999/mcp/',
          headers: { 'x-api-key': 'secret' },
        },
      },
      'external',
      'ping',
      {},
    );

    assert.equal(requestHeaders['x-api-key'], 'secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
