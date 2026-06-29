import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runChecks } from './startupCheck.js';

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
    const gaps = await runChecks();
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
    const gaps = await runChecks();
    assert.equal(hasGap(gaps, 'llm'), false);
  });
});
