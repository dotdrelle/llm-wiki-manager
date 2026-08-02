import { test } from 'node:test';
import assert from 'node:assert/strict';
import './mcpEndpoints.test.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildMcpStatus,
  callMcpTool,
  discoverMcpTools,
  formatMcpToolsForAgent,
  resetMcpSessionsForTests,
  resetMcpThrottleForTests,
  resolveRetryPolicy,
  resolveToolCallName,
  truncateToolResult,
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

test('formatMcpToolsForAgent advertises qualified server__tool names only', () => {
  const listing = formatMcpToolsForAgent(resolveFixtureStatus);
  assert.match(listing, /cme__cme_status/);
  assert.match(listing, /production__production_start_job/);
  // No bare tool name outside a qualified form.
  assert.doesNotMatch(listing, /(?<![\w])cme_status(?![\w])/);
  assert.doesNotMatch(listing, /(?<![\w])production_start_job(?![\w])/);
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

test('callMcpTool throttles MCP traffic independently per endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = process.env.WIKI_MANAGER_MCP_RATE_LIMIT_WINDOW_MS;
  const starts = [];
  globalThis.fetch = async (_url, init) => {
    // Only tool traffic is throttled; the one-off session handshake is not.
    if (JSON.parse(init.body).method === 'tools/call') starts.push(Date.now());
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
    };
  };
  process.env.WIKI_MANAGER_MCP_RATE_LIMIT_WINDOW_MS = '30';
  resetMcpThrottleForTests();
  resetMcpSessionsForTests();

  try {
    const status = {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        requestsPerMinute: 1,
      },
    };
    await Promise.all([
      callMcpTool(status, 'production', 'agent_status', { jobId: 'a' }),
      callMcpTool(status, 'production', 'agent_status', { jobId: 'b' }),
    ]);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 20, `expected throttling delay, got ${starts[1] - starts[0]}ms`);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow == null) delete process.env.WIKI_MANAGER_MCP_RATE_LIMIT_WINDOW_MS;
    else process.env.WIKI_MANAGER_MCP_RATE_LIMIT_WINDOW_MS = originalWindow;
    resetMcpThrottleForTests();
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

// A stateful server may reject any cold request, and every SDK words that
// rejection differently ("No valid session" for the Node SDK, "Missing session
// ID" for the Python one CME runs). The client must never read that prose: it
// handshakes first, so the rejection is simply never provoked.
function statefulMcpServer(rejectionMessage, { onMethod } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    onMethod?.(body.method, init.headers['mcp-session-id'] ?? null);
    if (body.method !== 'initialize' && !init.headers['mcp-session-id']) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: rejectionMessage },
          id: null,
        }),
      };
    }
    if (body.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === 'mcp-session-id' ? 'session-1' : null },
        text: async () => '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18"}}',
      };
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"cme_status"}]}}',
    };
  };
}

for (const rejection of ['No valid session', 'Missing session ID', 'Session not found']) {
  test(`discoverMcpTools handshakes before the first call — server says "${rejection}"`, async () => {
    const originalFetch = globalThis.fetch;
    const methods = [];
    resetMcpSessionsForTests();
    globalThis.fetch = statefulMcpServer(rejection, { onMethod: (m) => methods.push(m) });

    try {
      const status = await discoverMcpTools({
        cme: {
          status: 'configured',
          url: 'http://127.0.0.1:3336/mcp/',
          headers: { authorization: 'Bearer token' },
        },
      });

      assert.equal(status.cme.status, 'connected', status.cme.toolError ?? '');
      assert.deepEqual(status.cme.tools.map((tool) => tool.name), ['cme_status']);
      // initialize comes first: the cold rejection is never provoked, so its
      // wording cannot matter.
      assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
    } finally {
      globalThis.fetch = originalFetch;
      resetMcpSessionsForTests();
    }
  });
}

test('discoverMcpTools reuses one handshake across concurrent endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  resetMcpSessionsForTests();
  globalThis.fetch = statefulMcpServer('Missing session ID', { onMethod: (m) => methods.push(m) });

  try {
    const endpoint = {
      status: 'configured',
      url: 'http://127.0.0.1:3336/mcp/',
      headers: { authorization: 'Bearer token' },
    };
    await discoverMcpTools({ cme: endpoint });
    await discoverMcpTools({ cme: { ...endpoint } });

    // Second pass rebuilds the endpoint object from the endpoints file, yet the
    // session is keyed by transport identity — no second handshake.
    assert.deepEqual(
      methods.filter((m) => m === 'initialize').length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetMcpSessionsForTests();
  }
});

test('discoverMcpTools accepts a stateless server that issues no session id', async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  resetMcpSessionsForTests();
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    methods.push(body.method);
    if (body.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18"}}',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"documents_convert_to_markdown"}]}}',
    };
  };

  try {
    const status = await discoverMcpTools({
      documents: { status: 'configured', url: 'http://127.0.0.1:3337/mcp/' },
    });

    assert.equal(status.documents.status, 'connected', status.documents.toolError ?? '');
    // No session id issued: no notifications/initialized, and no re-handshake.
    assert.deepEqual(methods, ['initialize', 'tools/list']);
  } finally {
    globalThis.fetch = originalFetch;
    resetMcpSessionsForTests();
  }
});

test('callMcpTool re-negotiates and replays once when the agent drops the session', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sessions = ['stale-session', 'fresh-session'];
  resetMcpSessionsForTests();
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({
      method: body.method,
      sessionId: init.headers['mcp-session-id'] ?? null,
    });
    if (body.method === 'initialize') {
      const issued = sessions.shift();
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === 'mcp-session-id' ? issued : null },
        text: async () => '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18"}}',
      };
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
    }
    // The agent restarted: the session it issued is gone. The body is
    // deliberately opaque — recovery keys on the status code alone.
    if (init.headers['mcp-session-id'] === 'stale-session') {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => 'Not Found',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"status: configured"}]}}',
    };
  };

  try {
    const endpoint = { status: 'connected', url: 'http://127.0.0.1:3336/mcp/' };
    const result = await callMcpTool({ cme: endpoint }, 'cme', 'cme_status', { workspace: 'juno' });

    assert.equal(result.content[0].text, 'status: configured');
    assert.deepEqual(requests, [
      { method: 'initialize', sessionId: null },
      { method: 'notifications/initialized', sessionId: 'stale-session' },
      { method: 'tools/call', sessionId: 'stale-session' },
      { method: 'initialize', sessionId: null },
      { method: 'notifications/initialized', sessionId: 'fresh-session' },
      { method: 'tools/call', sessionId: 'fresh-session' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    resetMcpSessionsForTests();
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

test('truncateToolResult keeps short results intact and bounds long ones head+tail', () => {
  assert.equal(truncateToolResult('short result', 100), 'short result');

  const long = `START-${'x'.repeat(50000)}-END`;
  const bounded = truncateToolResult(long, 1000);
  assert.ok(bounded.length < 1200, `bounded length ${bounded.length} should stay near the cap`);
  assert.match(bounded, /^START-/);
  assert.match(bounded, /-END$/);
  assert.match(bounded, /caractères tronqués/);
});

test('formatMcpToolsForAgent names unreachable agents instead of hiding them', () => {
  const listing = formatMcpToolsForAgent({
    documents: { status: 'connected', tools: [{ name: 'documents_convert_to_markdown' }] },
    cme: { status: 'configured', toolError: '400 Bad Request: Missing session ID' },
  });

  assert.match(listing, /documents__documents_convert_to_markdown/);
  assert.match(listing, /Unreachable right now: cme \(400 Bad Request: Missing session ID\)/);
  // The model must not be able to read this as "not configured".
  assert.match(listing, /never\s+infer that such an agent is unconfigured/);
});

test('formatMcpToolsForAgent stays silent about endpoints that simply are not running', () => {
  const listing = formatMcpToolsForAgent({
    wiki: { status: 'configured', runtime: 'not running' },
    documents: { status: 'connected', tools: [{ name: 'documents_convert_to_markdown' }] },
  });

  assert.doesNotMatch(listing, /Unreachable/);
});
