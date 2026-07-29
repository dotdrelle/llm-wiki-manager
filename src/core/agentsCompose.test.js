import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { loadManagerEnv } from './env.js';
import { isEnabled, resolveAgentsComposeContext, resolvedManagerEnv } from './agentsCompose.js';

async function withManagerState(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-agents-compose-'));
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  const previousEnvFile = process.env.WIKI_MANAGER_ENV_FILE;
  const previousFlag = process.env.CONNECTORS_ENABLED;
  process.env.WIKI_MANAGER_ENV_FILE = join(root, '.env');
  try {
    await fn({ root });
  } finally {
    if (previousEnvFile === undefined) delete process.env.WIKI_MANAGER_ENV_FILE;
    else process.env.WIKI_MANAGER_ENV_FILE = previousEnvFile;
    if (previousFlag === undefined) delete process.env.CONNECTORS_ENABLED;
    else process.env.CONNECTORS_ENABLED = previousFlag;
  }
}

test('isEnabled accepts every documented truthy spelling', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
    assert.equal(isEnabled(value), true, value);
  }
  for (const value of ['0', 'false', 'no', 'off', '', undefined, null, 'maybe']) {
    assert.equal(isEnabled(value), false, String(value));
  }
});

test('the connectors profile activates from the manager .env alone', async () => {
  await withManagerState({ '.env': 'CONNECTORS_ENABLED=true\n' }, () => {
    delete process.env.CONNECTORS_ENABLED;
    assert.deepEqual(resolveAgentsComposeContext().profiles, ['connectors']);
  });
});

test('the connectors profile activates from process.env when the .env is silent', async () => {
  await withManagerState({ '.env': 'WORKSPACES_ROOT=/tmp/ws\n' }, () => {
    process.env.CONNECTORS_ENABLED = 'true';
    assert.deepEqual(resolveAgentsComposeContext().profiles, ['connectors']);
  });
});

test('the manager .env wins over the ambient process environment', async () => {
  // The manager enforces this policy before invoking Compose; otherwise an
  // exported empty/stale value would beat --env-file.
  await withManagerState({ '.env': 'CONNECTORS_ENABLED=false\n' }, () => {
    process.env.CONNECTORS_ENABLED = 'true';
    assert.equal(resolvedManagerEnv().CONNECTORS_ENABLED, 'false');
    assert.deepEqual(resolveAgentsComposeContext().profiles, []);
  });
});

test('an explicit manager env reload replaces values generated after boot', async () => {
  await withManagerState({ '.env': 'CONNECTORS_MCP_AUTH_TOKEN=fresh-token\n' }, () => {
    process.env.CONNECTORS_MCP_AUTH_TOKEN = '';
    loadManagerEnv();
    assert.equal(process.env.CONNECTORS_MCP_AUTH_TOKEN, '');
    loadManagerEnv({ override: true });
    assert.equal(process.env.CONNECTORS_MCP_AUTH_TOKEN, 'fresh-token');
    delete process.env.CONNECTORS_MCP_AUTH_TOKEN;
  });
});

test('the user-owned override is passed whenever it exists', async () => {
  await withManagerState({
    '.env': 'CONNECTORS_ENABLED=true\n',
    '.wiki/compose/agents.docker-compose.override.yml': 'services: {}\n',
  }, ({ root }) => {
    const { args, composeFiles, overrideFile } = resolveAgentsComposeContext();
    assert.equal(overrideFile, join(root, '.wiki', 'compose', 'agents.docker-compose.override.yml'));
    assert.equal(composeFiles.length, 2);
    assert.ok(args.includes(overrideFile));
    assert.deepEqual(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2), ['--profile', 'connectors']);
    assert.deepEqual(args.slice(-2), ['-p', 'wiki-agents']);
    assert.ok(args.includes('--env-file'));
  });
});

test('a missing override and a missing .env are both valid', async () => {
  await withManagerState({}, () => {
    delete process.env.CONNECTORS_ENABLED;
    const { args, composeFiles, profiles } = resolveAgentsComposeContext();
    assert.equal(composeFiles.length, 1);
    assert.deepEqual(profiles, []);
    assert.equal(args.includes('--env-file'), false);
  });
});
