import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleSlashCommand } from './slash.js';

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
