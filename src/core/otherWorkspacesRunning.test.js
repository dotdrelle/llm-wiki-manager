import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { otherWorkspacesRunning } from './compose.js';

// `otherWorkspacesRunning` shells out to `docker compose ps` per workspace.
// Docker is not available in the test environment, so every probe throws —
// which is itself the behaviour worth pinning: a workspace that cannot be
// queried must read as NOT running, or one stale registry entry would make
// the shared agents impossible to stop for good.

function workspaceEntry(root, name) {
  const registryPath = join(root, name);
  mkdirSync(registryPath, { recursive: true });
  const envFile = join(registryPath, '.env');
  writeFileSync(envFile, `WORKSPACE_NAME=${name}\nWIKI_WORKSPACE_PATH=${registryPath}\n`, 'utf8');
  return {
    name,
    registryPath,
    envFile,
    workspacePath: registryPath,
    env: { WORKSPACE_NAME: name, WIKI_WORKSPACE_PATH: registryPath },
  };
}

test('the current workspace is never counted as another one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-running-self-'));
  const acme = workspaceEntry(root, 'acme');

  const busy = await otherWorkspacesRunning({ workspace: 'acme' }, [acme]);

  assert.deepEqual(busy, [], 'stopping a workspace must not be blocked by itself');
});

test('an unqueryable workspace does not hold the shared agents hostage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-running-unknown-'));
  const workspaces = [workspaceEntry(root, 'acme'), workspaceEntry(root, 'stale')];

  const busy = await otherWorkspacesRunning({ workspace: 'acme' }, workspaces);

  assert.deepEqual(busy, []);
});

test('a single workspace, or none at all, never blocks', async () => {
  assert.deepEqual(await otherWorkspacesRunning({ workspace: 'acme' }, []), []);
  assert.deepEqual(await otherWorkspacesRunning({}, []), []);
  // Entries without a name are registry noise, not workspaces.
  assert.deepEqual(await otherWorkspacesRunning({ workspace: 'acme' }, [{}, null]), []);
});
