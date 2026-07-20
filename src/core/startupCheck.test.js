import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkInternetConnectivity, checkMcpConnections, runChecks, runPreflightChecks, withRuntimePreflight } from './startupCheck.js';

async function withWorkspace(wikircLines, fn) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-startup-check-'));
  const registryRoot = join(root, 'registry');
  const registryPath = join(registryRoot, 'demo');
  const workspacePath = join(root, 'workspace');
  mkdirSync(registryPath, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(registryPath, '.env'), [
    'WORKSPACE_NAME=demo',
    `WIKI_WORKSPACE_PATH=${workspacePath}`,
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(workspacePath, '.wikirc.yaml'), [...wikircLines, ''].join('\n'), 'utf8');

  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;
  try {
    await fn({ workspacePath });
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
}

function hasGap(gaps, kind) {
  return gaps.some((gap) => gap.kind === kind);
}

test('runChecks treats default LLM config without baseUrl as incomplete', async () => {
  await withWorkspace([
    'llm:',
    '  provider: openai-compatible',
    '  apiKey: key',
    '  model: chat-model',
    'retrieval:',
    '  vector:',
    '    enabled: true',
  ], async () => {
    const gaps = await runChecks({
      dockerCheck: async () => ({ ok: true }),
      internetCheck: async () => ({ ok: true }),
      agentsCheck: async () => null,
      workspaceContainersCheck: async () => ({ ok: true, detail: 'running' }),
      mcpCheck: async () => ({ ok: true, detail: 'connected' }),
    });
    assert.equal(hasGap(gaps, 'llm'), true);
  });
});

test('runChecks treats default LLM config with provider, baseUrl, apiKey and model as complete', async () => {
  await withWorkspace([
    'llm:',
    '  provider: openai-compatible',
    '  baseUrl: http://localhost:8000/v1',
    '  apiKey: key',
    '  model: chat-model',
    'retrieval:',
    '  vector:',
    '    enabled: true',
  ], async () => {
    const gaps = await runChecks({
      dockerCheck: async () => ({ ok: true }),
      internetCheck: async () => ({ ok: true }),
      agentsCheck: async () => null,
      workspaceContainersCheck: async () => ({ ok: true, detail: 'running' }),
      mcpCheck: async () => ({ ok: true, detail: 'connected' }),
    });
    assert.equal(hasGap(gaps, 'llm'), false);
  });
});

test('runChecks reports and probes every registered workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-multi-startup-'));
  const registryRoot = join(root, 'registry');
  for (const name of ['alpha', 'beta']) {
    const registryPath = join(registryRoot, name);
    const workspacePath = join(root, name);
    mkdirSync(registryPath, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(registryPath, '.env'), `WORKSPACE_NAME=${name}\nWIKI_WORKSPACE_PATH=${workspacePath}\n`, 'utf8');
    writeFileSync(join(workspacePath, '.wikirc.yaml'), [
      'llm:',
      '  provider: openai-compatible',
      '  baseUrl: http://localhost:8000/v1',
      '  apiKey: key',
      '  model: chat-model',
      '',
    ].join('\n'), 'utf8');
  }
  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;
  try {
    const containerCalls = [];
    const mcpCalls = [];
    const reports = [];
    await runChecks({
      dockerCheck: async () => ({ ok: true }),
      internetCheck: async () => ({ ok: true }),
      agentsCheck: async () => null,
      workspaceContainersCheck: async (workspace) => {
        containerCalls.push(workspace.name);
        return {
          ok: false,
          pending: true,
          detail: 'to start',
          context: { unavailable: ['serve', 'mcp-http', 'production-mcp'], command: `wiki-workspace up ${workspace.name}` },
        };
      },
      mcpCheck: async (workspace) => {
        mcpCalls.push(workspace.name);
        return { ok: true, detail: 'connected', context: { endpoints: [{ name: 'wiki', status: 'connected' }] } };
      },
      onCheck: (check) => reports.push(check),
    });
    assert.deepEqual(containerCalls, ['alpha', 'beta']);
    assert.deepEqual(mcpCalls, ['alpha', 'beta']);
    const workspaceReport = reports.find((check) => check.kind === 'workspace');
    assert.equal(workspaceReport.detail, '2 registered: alpha, beta');
    assert.equal(
      reports.find((check) => check.kind === 'containers').detail,
      '2/2 workspaces to start: alpha, beta — services: serve, mcp-http, production-mcp',
    );
    assert.match(reports.find((check) => check.kind === 'mcp').detail, /2 workspace\(s\) checked/);
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
});

test('runChecks executes Docker before Internet and reports both failures in order', async () => {
  const calls = [];
  const reports = [];
  const gaps = await runChecks({
    dockerCheck: async () => { calls.push('docker'); return { ok: false, context: { dockerUnavailable: true } }; },
    internetCheck: async () => { calls.push('internet'); return { ok: false, context: { error: 'offline' } }; },
    agentsCheck: async () => { calls.push('agents'); return null; },
    onCheck: (check) => reports.push(check.kind),
  });
  assert.deepEqual(calls, ['docker', 'internet']);
  assert.deepEqual(reports.slice(0, 3), ['docker', 'internet', 'agents']);
  assert.deepEqual(gaps.slice(0, 2).map((gap) => gap.kind), ['agents', 'network']);
});

test('MCP preflight distinguishes authentication failure and skips remote endpoints while offline', async () => {
  const workspace = { name: 'demo', workspacePath: '/tmp/demo', envFile: '/tmp/demo.env', env: {} };
  const result = await checkMcpConnections(workspace, {
    internetAvailable: false,
    buildStatus: () => ({
      local: { status: 'configured', url: 'http://127.0.0.1:3333/mcp' },
      remote: { status: 'configured', url: 'https://mcp.example.test', external: true },
    }),
    discover: async (endpoints) => ({
      local: { ...endpoints.local, status: 'configured', tools: [], toolError: '401 Unauthorized' },
    }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.context.endpoints.map(({ name, status, reason }) => ({ name, status, reason })), [
    { name: 'local', status: 'failed', reason: 'authentication' },
    { name: 'remote', status: 'skipped', reason: 'internet unavailable' },
  ]);
});

test('MCP preflight reports invalid endpoint configuration without aborting startup', async () => {
  const result = await checkMcpConnections({ name: 'demo', workspacePath: '/tmp/demo', env: {} }, {
    buildStatus: () => { throw new Error('Unexpected token in mcp.endpoints.json'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'MCP configuration invalid');
  assert.match(result.context.error, /mcp\.endpoints\.json/);
});

test('preflight status is setup_required without a valid workspace and runtime failure only degrades', async () => {
  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-empty-startup-'));
  process.env.WIKI_WORKSPACES_DIR = root;
  try {
    const preflight = await runPreflightChecks({
      dockerCheck: async () => ({ ok: true }),
      internetCheck: async () => ({ ok: true }),
      agentsCheck: async () => null,
    });
    assert.equal(preflight.status, 'setup_required');
    assert.equal(withRuntimePreflight(preflight, { error: 'offline' }).status, 'setup_required');
    const ready = { gaps: [], status: 'ready', checks: [{ kind: 'docker', ok: true }] };
    assert.equal(withRuntimePreflight(ready, { error: 'offline' }).status, 'degraded');
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
});

test('runChecks presents Internet failure before stopped agents after Docker succeeds', async () => {
  const gaps = await runChecks({
    dockerCheck: async () => ({ ok: true }),
    internetCheck: async () => ({ ok: false, context: { error: 'offline' } }),
    agentsCheck: async () => ({ kind: 'agents', context: { downServices: ['documents'] } }),
    workspaceContainersCheck: async () => ({ ok: false, detail: 'stopped' }),
    mcpCheck: async () => ({ ok: false, detail: 'unavailable' }),
  });
  assert.deepEqual(gaps.slice(0, 2).map((gap) => gap.kind), ['network', 'agents']);
});

test('runChecks still probes MCP endpoints when Docker is unavailable', async () => {
  await withWorkspace([
    'llm:',
    '  provider: openai-compatible',
    '  baseUrl: http://localhost:8000/v1',
    '  apiKey: key',
    '  model: chat-model',
  ], async () => {
    const calls = [];
    await runChecks({
      dockerCheck: async () => ({ ok: false, context: { dockerUnavailable: true } }),
      internetCheck: async () => ({ ok: true }),
      agentsCheck: async () => { calls.push('agents'); return null; },
      workspaceContainersCheck: async () => { calls.push('containers'); return { ok: true }; },
      mcpCheck: async () => { calls.push('mcp'); return { ok: true, detail: 'remote connected' }; },
    });
    assert.deepEqual(calls, ['mcp']);
  });
});

test('checkInternetConnectivity uses a fresh Node process with proxy and CA environment', async () => {
  const calls = [];
  const previousProxy = process.env.HTTPS_PROXY;
  const previousProxyFlag = process.env.NODE_USE_ENV_PROXY;
  process.env.HTTPS_PROXY = 'http://proxy.test:8080';
  process.env.NODE_USE_ENV_PROXY = '1';
  try {
    const result = await checkInternetConnectivity({
      url: 'https://connectivity.test/ping',
      exec: async (...args) => { calls.push(args); return { stdout: '' }; },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].at(-1), 'https://connectivity.test/ping');
    assert.equal(calls[0][2].env.HTTPS_PROXY, 'http://proxy.test:8080');
    assert.equal(result.context.proxyEnabled, true);
  } finally {
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousProxy;
    if (previousProxyFlag === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = previousProxyFlag;
  }
});
