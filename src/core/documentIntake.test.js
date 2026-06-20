import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    workspace: 'juno',
    mcp: {},
  };

  try {
    const { record, converted } = await storeAndMaybeConvertDocument(session, source);
    assert.equal(converted, false);
    assert.equal(record.workspace, 'juno');
    assert.equal(record.status, 'stored');
    assert.equal(record.agentPath.startsWith('/documents/input/juno/'), true);
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
