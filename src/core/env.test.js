import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureManagerScaffold } from './env.js';

// ensureManagerScaffold resolves the manager state dir from
// WIKI_MANAGER_ENV_FILE — point it at a temp dir for each test.
function withTempManagerDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-manager-env-test-'));
  const previous = process.env.WIKI_MANAGER_ENV_FILE;
  process.env.WIKI_MANAGER_ENV_FILE = join(dir, '.env');
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.WIKI_MANAGER_ENV_FILE;
    else process.env.WIKI_MANAGER_ENV_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scaffold copies the packaged examples into a fresh directory', () => {
  withTempManagerDir((dir) => {
    const created = ensureManagerScaffold();
    assert.ok(created.includes('mcp.endpoints.json'));
    assert.ok(created.includes('.env'));
    const endpoints = JSON.parse(readFileSync(join(dir, 'mcp.endpoints.json'), 'utf8'));
    assert.ok(endpoints.mcpServers);
    assert.ok(endpoints.chatAccess);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    // Active, not commented: serve runs in Docker and reaches the runtime
    // through host.docker.internal, which a loopback bind refuses.
    assert.match(env, /^WIKI_MANAGER_RUNTIME_HOST=0\.0\.0\.0$/m);
    assert.match(env, /^# WIKI_MANAGER_RUNTIME_PORT=7788$/m);
  });
});

test('scaffold seeds an enabled agent-runtimes example and never rewrites an existing one', () => {
  withTempManagerDir((dir) => {
    const created = ensureManagerScaffold();
    assert.ok(created.includes('agent-runtimes.json'));
    const runtimes = JSON.parse(readFileSync(join(dir, 'agent-runtimes.json'), 'utf8'));
    assert.ok(Array.isArray(runtimes.runtimes));
    assert.equal(runtimes.runtimes[0].enabled, true, 'the scaffold ships the gateway enabled (GATEWAY_ENABLED=true)');

    // Operator-owned: once present, the file is never touched again.
    writeFileSync(join(dir, 'agent-runtimes.json'), JSON.stringify({ runtimes: [] }));
    const second = ensureManagerScaffold();
    assert.ok(!second.includes('agent-runtimes.json'));
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'agent-runtimes.json'), 'utf8')),
      { runtimes: [] },
    );
  });
});

test('an install predating the required runtime host receives it on its placeholder', () => {
  withTempManagerDir((dir) => {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, [
      'WORKSPACES_ROOT=/srv/workspaces',
      '# WIKI_MANAGER_RUNTIME_PORT=7788',
      '# WIKI_MANAGER_RUNTIME_HOST=0.0.0.0',
      '',
    ].join('\n'));

    const created = ensureManagerScaffold();
    assert.ok(created.some((item) => item.includes('WIKI_MANAGER_RUNTIME_HOST')));
    const env = readFileSync(envFile, 'utf8');
    assert.match(env, /^WIKI_MANAGER_RUNTIME_HOST=0\.0\.0\.0$/m);
    assert.doesNotMatch(env, /^#\s*WIKI_MANAGER_RUNTIME_HOST=/m);
    assert.match(env, /^WORKSPACES_ROOT=\/srv\/workspaces$/m);
  });
});

test('an operator who deliberately kept the loopback bind is never overruled', () => {
  withTempManagerDir((dir) => {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'WIKI_MANAGER_RUNTIME_HOST=127.0.0.1\n');

    const created = ensureManagerScaffold();
    assert.ok(!created.some((item) => item.includes('WIKI_MANAGER_RUNTIME_HOST')));
    assert.match(readFileSync(envFile, 'utf8'), /^WIKI_MANAGER_RUNTIME_HOST=127\.0\.0\.1$/m);
  });
});

test('scaffold merges missing top-level keys into an existing endpoints file', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    // Pre-chatAccess install: only mcpServers, with operator edits.
    writeFileSync(endpointsFile, JSON.stringify({
      mcpServers: { custom: { url: 'http://localhost:9999/mcp/' } },
    }, null, 2));
    const created = ensureManagerScaffold();
    assert.ok(created.some((item) => item.includes('chatAccess')));
    const merged = JSON.parse(readFileSync(endpointsFile, 'utf8'));
    // Operator's server is untouched; packaged servers are added without
    // replacing any existing definitions.
    assert.deepEqual(merged.mcpServers.custom, { url: 'http://localhost:9999/mcp/' });
    assert.ok(merged.mcpServers.cme);
    assert.ok(merged.mcpServers.documents);
    // Server keys must match the connected MCP endpoint keys (the tool-call
    // prefix): the wiki server is "llm-wiki", not "wiki".
    assert.ok(merged.chatAccess?.servers?.['llm-wiki']);
    assert.ok(merged.chatAccess.servers['llm-wiki'].allow.includes('template_write'));
  });
});

test('scaffold never overwrites an existing chatAccess, including explicit null', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    writeFileSync(endpointsFile, JSON.stringify({
      mcpServers: {},
      chatAccess: null,
    }, null, 2));
    ensureManagerScaffold();
    const after = JSON.parse(readFileSync(endpointsFile, 'utf8'));
    // null means "deliberately disabled" — the merge must preserve it.
    assert.equal(after.chatAccess, null);
  });
});

test('scaffold upgrades the packaged wiki chat allow-list with template authoring tools', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    const example = JSON.parse(readFileSync('mcp.endpoints.example.json', 'utf8'));
    example.chatAccess.servers['llm-wiki'].allow = example.chatAccess.servers['llm-wiki'].allow
      .filter((tool) => !['wiki_outline', 'template_read', 'template_write', 'build_context_write'].includes(tool));
    writeFileSync(endpointsFile, JSON.stringify(example, null, 2));

    const changes = ensureManagerScaffold();
    const after = JSON.parse(readFileSync(endpointsFile, 'utf8'));

    assert.ok(changes.some((item) => item.includes('template_write')));
    assert.ok(after.chatAccess.servers['llm-wiki'].allow.includes('wiki_outline'));
    assert.ok(after.chatAccess.servers['llm-wiki'].allow.includes('template_read'));
    assert.ok(after.chatAccess.servers['llm-wiki'].allow.includes('template_write'));
    assert.ok(after.chatAccess.servers['llm-wiki'].allow.includes('build_context_write'));
  });
});

test('scaffold upgrades the packaged cme chat allow-list with the live search tools', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    const example = JSON.parse(readFileSync('mcp.endpoints.example.json', 'utf8'));
    example.chatAccess.servers.cme.allow = ['cme_status', 'cme_sources_list', 'cme_export_status'];
    writeFileSync(endpointsFile, JSON.stringify(example, null, 2));

    const changes = ensureManagerScaffold();
    const after = JSON.parse(readFileSync(endpointsFile, 'utf8'));

    assert.ok(changes.some((item) => item.includes('cme_confluence_search')));
    assert.deepEqual(after.chatAccess.servers.cme.allow, [
      'cme_status', 'cme_sources_list', 'cme_export_status', 'cme_confluence_search', 'cme_wiki_search',
    ]);
  });
});

test('scaffold leaves a custom cme chat allow-list untouched', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    writeFileSync(endpointsFile, JSON.stringify({
      mcpServers: {},
      chatAccess: { servers: { cme: { allow: ['cme_status'] } } },
    }, null, 2));

    ensureManagerScaffold();
    const after = JSON.parse(readFileSync(endpointsFile, 'utf8'));
    assert.deepEqual(after.chatAccess.servers.cme.allow, ['cme_status']);
  });
});

test('scaffold leaves a custom wiki chat allow-list untouched', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    writeFileSync(endpointsFile, JSON.stringify({
      mcpServers: {},
      chatAccess: { servers: { 'llm-wiki': { allow: ['wiki_read_page'] } } },
    }, null, 2));

    ensureManagerScaffold();
    const after = JSON.parse(readFileSync(endpointsFile, 'utf8'));
    assert.deepEqual(after.chatAccess.servers['llm-wiki'].allow, ['wiki_read_page']);
  });
});

test('scaffold does not restore a packaged MCP explicitly removed in the UI', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    writeFileSync(endpointsFile, JSON.stringify({
      mcpServers: {},
      disabledMcpServers: ['cme'],
    }, null, 2));
    ensureManagerScaffold();
    const after = JSON.parse(readFileSync(endpointsFile, 'utf8'));
    assert.equal(after.mcpServers.cme, undefined);
    assert.ok(after.mcpServers.documents);
  });
});

test('scaffold leaves an invalid endpoints file strictly alone', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    writeFileSync(endpointsFile, '{ not json');
    ensureManagerScaffold();
    assert.equal(readFileSync(endpointsFile, 'utf8'), '{ not json');
  });
});
