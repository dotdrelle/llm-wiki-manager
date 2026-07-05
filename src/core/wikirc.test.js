import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { patchWikircProfile } from './wikirc.js';
import { finalizeCreatedWorkspace, writeVectorConfig } from './wikiSetup.js';

test('patchWikircProfile merges keys and preserves existing values', () => {
  const root = mkdtempSync(join(tmpdir(), 'wikirc-patch-'));
  const file = join(root, '.wikirc.yaml');
  writeFileSync(file, [
    '# workspace config',
    'language: en-US',
    'llm:',
    '  provider: openai',
    '  temperature: 0.2',
    '',
  ].join('\n'), 'utf8');

  patchWikircProfile(root, 'default', {
    llm: {
      model: 'gpt-5.4-mini',
      apiKey: 'secret',
    },
    retrieval: {
      vector: {
        enabled: true,
        embeddingModel: 'text-embedding-3-small',
      },
    },
  });

  const raw = readFileSync(file, 'utf8');
  const parsed = YAML.parse(raw);
  assert.match(raw, /# workspace config/);
  assert.equal(parsed.language, 'en-US');
  assert.equal(parsed.llm.provider, 'openai');
  assert.equal(parsed.llm.temperature, 0.2);
  assert.equal(parsed.llm.model, 'gpt-5.4-mini');
  assert.equal(parsed.retrieval.vector.enabled, true);
});

test('writeVectorConfig writes llm-wiki vector and rerank keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'wikirc-vector-'));
  writeFileSync(join(root, '.wikirc.yaml'), [
    'language: en',
    'llm:',
    '  provider: openai-compatible',
    '  baseUrl: http://localhost:8000/v1',
    '  apiKey: llm-key',
    '  model: chat-model',
    'retrieval:',
    '  vector:',
    '    enabled: false',
    '',
  ].join('\n'), 'utf8');

  writeVectorConfig(root, 'default', {
    baseUrl: 'http://localhost:7997/v1',
    apiKey: 'vector-key',
    embeddingModel: 'BAAI/bge-m3',
    rerankEnabled: true,
    rerankerModel: 'BAAI/bge-reranker-v2-m3',
  });

  const parsed = YAML.parse(readFileSync(join(root, '.wikirc.yaml'), 'utf8'));
  assert.equal(parsed.retrieval.vector.enabled, true);
  assert.equal(parsed.retrieval.vector.baseUrl, 'http://localhost:7997/v1');
  assert.equal(parsed.retrieval.vector.apiKey, 'vector-key');
  assert.equal(parsed.retrieval.vector.embeddingModel, 'BAAI/bge-m3');
  assert.equal(parsed.retrieval.vector.rerankEnabled, true);
  assert.equal(parsed.retrieval.vector.rerankerModel, 'BAAI/bge-reranker-v2-m3');
});

test('writeVectorConfig removes commented vector placeholders it replaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'wikirc-vector-comments-'));
  writeFileSync(join(root, '.wikirc.yaml'), [
    'language: en',
    'llm:',
    '  provider: openai-compatible',
    '  baseUrl: http://localhost:8000/v1',
    '  apiKey: llm-key',
    '  model: chat-model',
    'retrieval:',
    '  vector:',
    '    enabled: false',
    '    # Defaults to llm.baseUrl.',
    '    # baseUrl: http://127.0.0.1:7997/v1',
    '    # apiKey: your-vector-key',
    '    embeddingModel: BAAI/bge-m3',
    '    rerankerModel: BAAI/bge-reranker-v2-m3',
    '',
  ].join('\n'), 'utf8');

  writeVectorConfig(root, 'default', {
    baseUrl: 'http://localhost:7997/v1',
    apiKey: 'vector-key',
    embeddingModel: 'BAAI/bge-m3',
    rerankEnabled: true,
    rerankerModel: 'custom-reranker',
  });

  const raw = readFileSync(join(root, '.wikirc.yaml'), 'utf8');
  const parsed = YAML.parse(raw);
  assert.doesNotMatch(raw, /^\s*#\s*baseUrl:/m);
  assert.doesNotMatch(raw, /^\s*#\s*apiKey:/m);
  assert.equal(parsed.retrieval.vector.baseUrl, 'http://localhost:7997/v1');
  assert.equal(parsed.retrieval.vector.apiKey, 'vector-key');
});

test('finalizeCreatedWorkspace copies generated wiki token into default wikirc', () => {
  const root = mkdtempSync(join(tmpdir(), 'wikirc-workspace-token-'));
  const registryRoot = join(root, 'registry');
  const registryPath = join(registryRoot, 'demo');
  const workspacePath = join(root, 'workspace');
  const token = 'a'.repeat(64);
  mkdirSync(registryPath, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(
    join(registryPath, '.env'),
    [
      'WORKSPACE_NAME=demo',
      `WIKI_WORKSPACE_PATH=${workspacePath}`,
      `WIKI_MCP_AUTH_TOKEN=${token}`,
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(workspacePath, '.wikirc.yaml'),
    ['language: en', 'mcp:', '  # accessKey: your-secret-key', ''].join('\n'),
    'utf8',
  );

  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;
  try {
    const workspace = finalizeCreatedWorkspace('demo');
    const parsed = YAML.parse(readFileSync(join(workspacePath, '.wikirc.yaml'), 'utf8'));

    assert.equal(workspace.name, 'demo');
    assert.equal(parsed.mcp.accessKey, token);
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
});
