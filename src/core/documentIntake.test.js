import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listDocumentUploads,
  storeAndMaybeConvertDocument,
} from './documentIntake.js';

test('document intake stores uploads without requiring documents MCP', async () => {
  const originalAgentsDataDir = process.env.AGENTS_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-doc-intake-'));
  process.env.AGENTS_DATA_DIR = path.join(root, '.agents-data');
  const source = path.join(root, 'rapport.pdf');
  await writeFile(source, 'fake pdf content');
  const session = {
    workspace: 'my-project',
    mcp: {},
  };

  try {
    const { record, converted } = await storeAndMaybeConvertDocument(session, source);
    assert.equal(converted, false);
    assert.equal(record.workspace, 'my-project');
    assert.equal(record.status, 'stored');
    assert.equal(record.agentPath.startsWith('/documents/input/my-project/'), true);
    assert.equal(await readFile(record.storedPath, 'utf8'), 'fake pdf content');

    const uploads = await listDocumentUploads(session);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].id, record.id);
    assert.equal(uploads[0].error, 'documents MCP is not connected');
  } finally {
    if (originalAgentsDataDir === undefined) delete process.env.AGENTS_DATA_DIR;
    else process.env.AGENTS_DATA_DIR = originalAgentsDataDir;
  }
});

test('document intake falls back to workspace root agents data, not cwd', async () => {
  const originalAgentsDataDir = process.env.AGENTS_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-doc-intake-root-'));
  const workspacesRoot = path.join(root, 'workspaces');
  const workspacePath = path.join(workspacesRoot, 'my-project');
  await mkdir(workspacePath, { recursive: true });
  const source = path.join(root, 'rapport.pdf');
  await writeFile(source, 'fake pdf content');
  const session = {
    workspace: 'my-project',
    workspacePath,
    mcp: {},
  };

  try {
    delete process.env.AGENTS_DATA_DIR;
    const { record } = await storeAndMaybeConvertDocument(session, source);
    assert.equal(record.storedPath.startsWith(path.join(workspacesRoot, '.agents-data')), true);
    assert.equal(await readFile(record.storedPath, 'utf8'), 'fake pdf content');
  } finally {
    if (originalAgentsDataDir === undefined) delete process.env.AGENTS_DATA_DIR;
    else process.env.AGENTS_DATA_DIR = originalAgentsDataDir;
  }
});

test('document intake accepts quoted absolute paths with spaces', async () => {
  const originalAgentsDataDir = process.env.AGENTS_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-doc-intake-'));
  process.env.AGENTS_DATA_DIR = path.join(root, '.agents-data');
  const source = path.join(root, 'Screenshot 2026-06-21 at 10.03.36.png');
  await writeFile(source, 'fake png content');
  const session = {
    workspace: 'my-project',
    mcp: {},
  };

  try {
    const { record } = await storeAndMaybeConvertDocument(session, `'${source}'`);
    assert.equal(record.filename, 'Screenshot_2026-06-21_at_10.03.36.png');
    assert.equal(await readFile(record.storedPath, 'utf8'), 'fake png content');
  } finally {
    if (originalAgentsDataDir === undefined) delete process.env.AGENTS_DATA_DIR;
    else process.env.AGENTS_DATA_DIR = originalAgentsDataDir;
  }
});

test('document intake accepts double-quoted absolute paths with spaces', async () => {
  const originalAgentsDataDir = process.env.AGENTS_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-doc-intake-'));
  process.env.AGENTS_DATA_DIR = path.join(root, '.agents-data');
  const source = path.join(root, 'scan avec espace.pdf');
  await writeFile(source, 'fake pdf content');
  const session = {
    workspace: 'my-project',
    mcp: {},
  };

  try {
    const { record } = await storeAndMaybeConvertDocument(session, `"${source}"`);
    assert.equal(record.filename, 'scan_avec_espace.pdf');
    assert.equal(await readFile(record.storedPath, 'utf8'), 'fake pdf content');
  } finally {
    if (originalAgentsDataDir === undefined) delete process.env.AGENTS_DATA_DIR;
    else process.env.AGENTS_DATA_DIR = originalAgentsDataDir;
  }
});

test('document intake replaces an existing upload with the same original filename', async () => {
  const originalAgentsDataDir = process.env.AGENTS_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-manager-doc-intake-'));
  const agentsDataDir = path.join(root, '.agents-data');
  process.env.AGENTS_DATA_DIR = agentsDataDir;
  const source = path.join(root, 'rapport.pdf');
  const session = {
    workspace: 'my-project',
    mcp: {},
  };

  try {
    await writeFile(source, 'first pdf content');
    const first = (await storeAndMaybeConvertDocument(session, source)).record;
    const outputPath = path.join(root, 'workspace', 'raw', 'untracked', `${first.id}-rapport.md`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, 'old markdown');

    const manifest = path.join(agentsDataDir, 'documents', 'uploads', 'my-project.jsonl');
    const firstRecord = JSON.parse(await readFile(manifest, 'utf8'));
    await writeFile(manifest, `${JSON.stringify({ ...firstRecord, outputPath })}\n`, 'utf8');

    await writeFile(source, 'second pdf content');
    const second = (await storeAndMaybeConvertDocument(session, source)).record;

    assert.notEqual(second.id, first.id);
    assert.equal(existsSync(first.storedPath), false);
    assert.equal(existsSync(outputPath), false);
    assert.equal(await readFile(second.storedPath, 'utf8'), 'second pdf content');

    const uploads = await listDocumentUploads(session);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].id, second.id);
    assert.equal(uploads[0].filename, 'rapport.pdf');
  } finally {
    if (originalAgentsDataDir === undefined) delete process.env.AGENTS_DATA_DIR;
    else process.env.AGENTS_DATA_DIR = originalAgentsDataDir;
  }
});
