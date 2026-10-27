import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveRuntimeAuthToken } from '../../src/runtime/auth.js';
import { assertRuntimeNode, runtimeNodeExecutable } from '../../src/runtime/lifecycle.js';

test('resolveRuntimeAuthToken: a loopback or LAN bind gets a token too', () => {
  for (const host of ['127.0.0.1', '192.168.1.10']) {
    const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-auth-'));
    const result = resolveRuntimeAuthToken({ host, stateDir, explicitToken: null });
    assert.equal(result.source, 'generated', host);
    assert.match(result.token, /^[0-9a-f]{64}$/, host);
  }
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
