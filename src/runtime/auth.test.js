import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveRuntimeAuthToken } from './auth.js';
import { assertRuntimeNode, runtimeNodeExecutable, shutdownOwnedRuntime } from './lifecycle.js';

test('resolveRuntimeAuthToken: loopback host does not require token', () => {
  const result = resolveRuntimeAuthToken({ host: '127.0.0.1', explicitToken: null });
  assert.equal(result.token, null);
  assert.equal(result.source, 'none');
});

test('resolveRuntimeAuthToken: exposed host generates and reuses token', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-auth-'));
  const first = resolveRuntimeAuthToken({ host: '0.0.0.0', stateDir, explicitToken: null });
  const second = resolveRuntimeAuthToken({ host: '0.0.0.0', stateDir, explicitToken: null });
  assert.equal(first.source, 'generated');
  assert.equal(second.source, 'file');
  assert.equal(second.token, first.token);
});

test('runtime lifecycle uses a Node executable with node:sqlite support', async () => {
  const runtimeNode = await assertRuntimeNode(runtimeNodeExecutable());

  assert.ok(runtimeNode.executable);
  assert.ok(Number(runtimeNode.version.split('.')[0]) >= 22);
});

test('shutdownOwnedRuntime reports progress and stops an idle owned runtime', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const logs = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    return new Response(JSON.stringify(calls.length === 1 ? { activeRuns: [] } : { shutdown: true }), {
      status: calls.length === 1 ? 200 : 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await shutdownOwnedRuntime(
      { url: 'http://127.0.0.1:7788', started: true, token: null },
      { log: (message) => logs.push(message), timeoutMs: 100 },
    );
    assert.equal(result.action, 'shutdown');
    assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST']);
    assert.match(logs.join('\n'), /runtime arrêté/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shutdownOwnedRuntime bounds an unresponsive shutdown', async () => {
  const originalFetch = globalThis.fetch;
  const logs = [];
  globalThis.fetch = async (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  try {
    const result = await shutdownOwnedRuntime(
      { url: 'http://127.0.0.1:7788', started: true, token: null },
      { log: (message) => logs.push(message), timeoutMs: 5 },
    );
    assert.equal(result.action, 'timeout');
    assert.match(logs.join('\n'), /délai de fermeture/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
