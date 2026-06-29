import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleSlashCommand } from './slash.js';
import { completionContext } from '../shell/repl.js';

test('/workspace delete removes files and clears current session context after confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-delete-workspace-'));
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

  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;
  const session = {
    workspace: 'demo',
    workspacePath,
    workspaceEnv: { WORKSPACE_NAME: 'demo' },
    workspaceEnvFile: join(registryPath, '.env'),
    wikirc: { profile: 'default' },
    wikircConfig: {},
    language: 'en-US',
    llm: {},
    mcp: {},
    systemPrompt: 'prompt',
  };

  try {
    const prompt = await handleSlashCommand('/workspace delete demo', {
      packageJson: { version: 'test' },
      session,
    });
    assert.match(prompt.output, /Confirm workspace deletion: demo/);
    assert.equal(existsSync(workspacePath), true);
    assert.equal(session.workspace, 'demo');

    const result = await handleSlashCommand('/workspace delete demo --confirm', {
      packageJson: { version: 'test' },
      session,
    });
    assert.match(result.output, /Deleted workspace: demo/);
    assert.equal(session.workspace, null);
    assert.equal(session.workspacePath, null);
    assert.equal(session.llm, null);
    assert.equal(session.mcp, null);
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
});

test('/new without a name shows usage', async () => {
  const result = await handleSlashCommand('/new', {
    packageJson: { version: 'test' },
    session: {},
  });

  assert.match(result.output ?? '', /Usage/i);
});

test('/use lists profiles before selecting one when several wikirc profiles exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-use-profile-'));
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
  writeFileSync(join(workspacePath, '.wikirc.yaml'), [
    'language: fr',
    'llm:',
    '  provider: default-provider',
    '  model: default-model',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(workspacePath, '.wikirc.yaml.vpn'), [
    'language: fr',
    'llm:',
    '  provider: vpn-provider',
    '  model: vpn-model',
    '',
  ].join('\n'), 'utf8');

  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;

  try {
    const session = {};
    const listResult = await handleSlashCommand('/use demo', {
      packageJson: { version: 'test' },
      session,
    });

    assert.equal(session.workspace, 'demo');
    assert.equal(session.wikirc, null);
    assert.match(listResult.output ?? '', /Select config/);
    assert.match(listResult.output ?? '', /default\t\.wikirc\.yaml/);
    assert.match(listResult.output ?? '', /vpn\t\.wikirc\.yaml\.vpn/);
    assert.match(listResult.output ?? '', /\/use demo vpn/);

    const result = await handleSlashCommand('/use demo vpn', {
      packageJson: { version: 'test' },
      session,
    });

    assert.equal(session.workspace, 'demo');
    assert.equal(session.wikirc.profile, 'vpn');
    assert.match(result.output ?? '', /profile: vpn/);
    assert.match(result.output ?? '', /\* vpn\t\.wikirc\.yaml\.vpn/);
    assert.match(result.output ?? '', /Switch: \/use demo <profile>/);

    const colonResult = await handleSlashCommand('/use demo:vpn', {
      packageJson: { version: 'test' },
      session,
    });
    assert.equal(session.wikirc.profile, 'vpn');
    assert.match(colonResult.output ?? '', /profile: vpn/);

    const completion = completionContext('/use ', { commands: ['use'] });
    assert.deepEqual(completion?.matches, ['demo:default', 'demo:vpn']);
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
});
