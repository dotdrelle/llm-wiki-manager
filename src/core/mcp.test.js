import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildMcpStatus,
  callMcpTool,
  discoverMcpTools,
  resolveRetryPolicy,
  resolveToolCallName,
} from './mcp.js';

const resolveFixtureStatus = {
  production: {
    status: 'connected',
    tools: [{ name: 'production_start_job' }, { name: 'agent_status' }],
  },
  cme: {
    status: 'connected',
    tools: [{ name: 'cme_status' }, { name: 'agent_status' }],
  },
  documents: {
    status: 'configured', // not connected: must never be a candidate
    tools: [{ name: 'cme_status' }],
  },
};

test('resolveToolCallName passes qualified names through untouched', () => {
  const resolved = resolveToolCallName(resolveFixtureStatus, 'cme__cme_status');
  assert.deepEqual(
    { server: resolved.server, tool: resolved.tool, normalized: resolved.normalized },
    { server: 'cme', tool: 'cme_status', normalized: false },
  );
});

test('resolveToolCallName normalizes a bare name with exactly one connected match', () => {
  const resolved = resolveToolCallName(resolveFixtureStatus, 'cme_status');
  assert.deepEqual(
    { server: resolved.server, tool: resolved.tool, normalized: resolved.normalized },
    { server: 'cme', tool: 'cme_status', normalized: true },
  );
});

test('resolveToolCallName refuses ambiguous bare names and reports candidates', () => {
  const resolved = resolveToolCallName(resolveFixtureStatus, 'agent_status');
  assert.equal(resolved.server, null);
  assert.equal(resolved.normalized, false);
  assert.deepEqual([...resolved.candidates].sort(), ['cme', 'production']);
});

test('resolveToolCallName returns no server for unknown bare names', () => {
  const resolved = resolveToolCallName(resolveFixtureStatus, 'does_not_exist');
  assert.equal(resolved.server, null);
  assert.deepEqual(resolved.candidates, []);
});

test('resolveToolCallName resolves internal pseudo-server tools via extraServers', () => {
  const resolved = resolveToolCallName(resolveFixtureStatus, 'plan_set', { wiki: ['plan_set', 'plan_done'] });
  assert.deepEqual(
    { server: resolved.server, tool: resolved.tool, normalized: resolved.normalized },
    { server: 'wiki', tool: 'plan_set', normalized: true },
  );
});

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

test('buildMcpStatus reloads external endpoint keys changed in manager .env', async () => {
  const originalCwd = process.cwd();
  const originalToken = process.env.TEST_EXTERNAL_TOKEN;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-mcp-env-reload-'));
  await writeFile(
    path.join(root, '.env'),
    'TEST_EXTERNAL_TOKEN=first-token\n',
    'utf8',
  );
  await writeFile(
    path.join(root, 'mcp.endpoints.json'),
    JSON.stringify({
      mcpServers: {
        external: {
          url: 'http://127.0.0.1:9999/mcp/',
          headers: {
            Authorization: 'Bearer ${TEST_EXTERNAL_TOKEN}',
          },
        },
      },
    }),
    'utf8',
  );
  process.env.TEST_EXTERNAL_TOKEN = 'first-token';

  try {
    process.chdir(root);
    await writeFile(
      path.join(root, '.env'),
      'TEST_EXTERNAL_TOKEN=second-token\n',
      'utf8',
    );
    const status = buildMcpStatus({ workspaceEnv: {} });
    assert.deepEqual(status.external.headers, {
      authorization: 'Bearer second-token',
    });
  } finally {
    process.chdir(originalCwd);
    if (originalToken === undefined) delete process.env.TEST_EXTERNAL_TOKEN;
    else process.env.TEST_EXTERNAL_TOKEN = originalToken;
  }
});

test('buildMcpStatus does not use workspace env token for wiki MCP without active wikirc accessKey', () => {
  const status = buildMcpStatus({
    workspaceEnv: {
      WIKI_MCP_PORT: '3101',
      WIKI_MCP_AUTH_TOKEN: 'wiki-token-2',
      PRODUCTION_MCP_PORT: '3102',
      PRODUCTION_MCP_AUTH_TOKEN: 'production-token-2',
    },
  });

  assert.equal(status.wiki.status, 'missing');
  assert.equal(status.wiki.token, null);
  assert.match(status.wiki.detail, /mcp\.accessKey missing/);
  assert.equal(status.production.token, 'production-token-2');
});

test('buildMcpStatus uses active wikirc mcp.accessKey for wiki MCP', () => {
  const status = buildMcpStatus({
    workspaceEnv: {
      WIKI_MCP_PORT: '3101',
      WIKI_MCP_AUTH_TOKEN: 'env-wiki-token',
    },
    wikircConfig: {
      mcp: {
        accessKey: 'wikirc-wiki-token',
      },
    },
  });

  assert.equal(status.wiki.status, 'configured');
  assert.equal(status.wiki.token, 'wikirc-wiki-token');
});

test('buildMcpStatus applies internal tool approval policy from env', () => {
  const original = process.env.WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS;
  process.env.WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS = 'production.production_start_job,wiki.wiki_search';
  try {
    const status = buildMcpStatus({
      workspaceEnv: {
        PRODUCTION_MCP_PORT: '3102',
        PRODUCTION_MCP_AUTH_TOKEN: 'production-token',
        WIKI_MCP_PORT: '3101',
      },
      wikircConfig: {
        mcp: { accessKey: 'wiki-token' },
      },
    });

    assert.deepEqual(status.production.requireApproval, ['production_start_job']);
    assert.deepEqual(status.wiki.requireApproval, ['wiki_search']);
  } finally {
    if (original === undefined) delete process.env.WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS;
    else process.env.WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS = original;
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

test('callMcpTool retries transient MCP failures', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const retries = [];
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => 'temporarily unavailable',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
    };
  };

  try {
    const result = await callMcpTool(
      {
        production: {
          status: 'connected',
          url: 'http://127.0.0.1:3000/mcp/',
          retry: { maxAttempts: 2, backoffMs: 0 },
        },
      },
      'production',
      'production_start_job',
      { type: 'doctor' },
      null,
      { onRetry: (event) => retries.push(event) },
    );

    assert.equal(attempts, 2);
    assert.equal(retries.length, 1);
    assert.match(retries[0].error.message, /503/);
    assert.equal(result.content[0].text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callMcpTool retries tool result errors', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        result: attempts === 1
          ? { isError: true, content: [{ type: 'text', text: 'rate limited' }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] },
      }),
    };
  };

  try {
    const result = await callMcpTool(
      {
        production: {
          status: 'connected',
          url: 'http://127.0.0.1:3000/mcp/',
        },
      },
      'production',
      'production_start_job',
      { type: 'doctor' },
      null,
      { retry: { maxAttempts: 2, backoffMs: 0 } },
    );

    assert.equal(attempts, 2);
    assert.equal(result.content[0].text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveRetryPolicy supports endpoint and tool overrides', () => {
  const policy = resolveRetryPolicy({
    retry: { maxAttempts: 2, backoffMs: 100 },
    toolRetries: {
      production_start_job: { maxAttempts: 4 },
    },
  }, 'production_start_job');

  assert.deepEqual(policy, { maxAttempts: 4, backoffMs: 100 });
});

test('discoverMcpTools downgrades connected endpoint when tool discovery fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    text: async () => '{"error":"invalid or missing bearer token"}',
  });

  try {
    const status = await discoverMcpTools({
      wiki: {
        status: 'connected',
        url: 'http://127.0.0.1:3201/mcp',
        token: 'token',
      },
    });

    assert.equal(status.wiki.status, 'configured');
    assert.equal(status.wiki.tools.length, 0);
    assert.match(status.wiki.toolError, /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callMcpTool parses SSE responses after keepalive comments', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => [
      ': keepalive',
      '',
      'event: message',
      'data: {"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}',
      '',
    ].join('\n'),
  });

  try {
    const result = await callMcpTool(
      {
        documents: {
          status: 'connected',
          url: 'http://127.0.0.1:3337/mcp/',
        },
      },
      'documents',
      'documents_convert_to_markdown',
      { filePath: '/documents/input/example.pdf' },
    );

    assert.equal(result.content[0].text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
