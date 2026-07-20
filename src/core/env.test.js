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
    // Operator's servers untouched; new key added from the example.
    assert.deepEqual(merged.mcpServers, { custom: { url: 'http://localhost:9999/mcp/' } });
    assert.ok(merged.chatAccess?.servers?.wiki);
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

test('scaffold leaves an invalid endpoints file strictly alone', () => {
  withTempManagerDir((dir) => {
    const endpointsFile = join(dir, 'mcp.endpoints.json');
    writeFileSync(endpointsFile, '{ not json');
    ensureManagerScaffold();
    assert.equal(readFileSync(endpointsFile, 'utf8'), '{ not json');
  });
});
