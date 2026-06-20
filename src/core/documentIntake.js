import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { callMcpTool, formatMcpToolResult } from './mcp.js';
import { parseJsonText } from './activity.js';
import { userManagerDir } from './env.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.htm', '.rtf',
  '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp',
  '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls', '.odt', '.ods', '.odp',
  '.pdf',
]);

function agentsDataDir() {
  const configured = process.env.AGENTS_DATA_DIR || '.agents-data';
  return isAbsolute(configured) ? configured : resolve(userManagerDir(), configured);
}

function documentInputRoot() {
  return resolve(agentsDataDir(), 'documents', 'input');
}

function uploadsRoot() {
  return resolve(agentsDataDir(), 'documents', 'uploads');
}

function requireWorkspace(session) {
  if (!session?.workspace) throw new Error('No workspace loaded. Use /use <workspace>.');
  return session.workspace;
}

function maxUploadBytes() {
  const value = Number(process.env.DOCUMENT_MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
  return Number.isFinite(value) && value > 0 ? value : 50 * 1024 * 1024;
}

function sanitizeFilename(filename) {
  const name = basename(String(filename || '').trim())
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/g, '')
    .slice(0, 120);
  return name || 'upload.bin';
}

function assertSupportedFile(filename, size) {
  const ext = extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported document type: ${ext || 'no extension'}`);
  }
  const max = maxUploadBytes();
  if (size > max) {
    throw new Error(`Document is too large: ${size} bytes (max ${max}).`);
  }
}

function manifestPath(workspace) {
  return join(uploadsRoot(), `${workspace}.jsonl`);
}

async function readManifest(workspace) {
  const file = manifestPath(workspace);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function writeManifest(workspace, records) {
  const file = manifestPath(workspace);
  await mkdir(uploadsRoot(), { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, body ? `${body}\n` : '', 'utf8');
  await rename(tmp, file);
}

async function upsertUpload(record) {
  const records = await readManifest(record.workspace);
  const index = records.findIndex((item) => item.id === record.id);
  if (index === -1) records.unshift(record);
  else records[index] = { ...records[index], ...record };
  await writeManifest(record.workspace, records);
  return record;
}

function documentsConverter(session) {
  const endpoint = session?.mcp?.documents;
  if (endpoint?.status !== 'connected') return null;
  const hasTool = (endpoint.tools ?? []).some((tool) => tool.name === 'documents_convert_to_markdown');
  return hasTool ? endpoint : null;
}

function publicRecord(record) {
  return {
    id: record.id,
    workspace: record.workspace,
    filename: record.filename,
    status: record.status,
    provider: record.provider,
    agentPath: record.agentPath,
    outputPath: record.outputPath,
    method: record.method,
    bytes: record.bytes,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function storeDocumentUpload(session, sourcePath) {
  const workspace = requireWorkspace(session);
  const absolutePath = resolve(sourcePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Not a file: ${sourcePath}`);
  const filename = sanitizeFilename(absolutePath);
  assertSupportedFile(filename, info.size);

  const id = randomUUID().slice(0, 8);
  const storedFilename = `${id}-${filename}`;
  const workspaceInput = join(documentInputRoot(), workspace);
  await mkdir(workspaceInput, { recursive: true });
  const storedPath = join(workspaceInput, storedFilename);
  await copyFile(absolutePath, storedPath);
  const now = new Date().toISOString();
  const record = {
    id,
    workspace,
    filename,
    originalPath: absolutePath,
    storedPath,
    agentPath: `/documents/input/${workspace}/${storedFilename}`,
    status: 'stored',
    provider: null,
    outputPath: null,
    method: null,
    bytes: info.size,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await upsertUpload(record);
  return record;
}

export async function convertStoredDocument(session, id) {
  const workspace = requireWorkspace(session);
  const records = await readManifest(workspace);
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error(`Unknown upload id: ${id}`);
  if (!existsSync(record.storedPath)) throw new Error(`Stored file is missing: ${record.storedPath}`);
  if (!documentsConverter(session)) {
    record.status = 'stored';
    record.provider = null;
    record.error = 'documents MCP is not connected';
    record.updatedAt = new Date().toISOString();
    await upsertUpload(record);
    return { record, converted: false };
  }

  record.status = 'converting';
  record.provider = 'documents';
  record.error = null;
  record.updatedAt = new Date().toISOString();
  await upsertUpload(record);

  try {
    const result = await callMcpTool(session.mcp, 'documents', 'documents_convert_to_markdown', {
      workspace,
      filePath: record.agentPath,
      outputFilename: `${record.id}-${record.filename.replace(/\.[^.]+$/, '')}.md`,
    });
    const payload = parseJsonText(formatMcpToolResult(result)) ?? {};
    if (payload.ok === false) throw new Error(payload.error || 'documents conversion failed');
    record.status = 'converted';
    record.outputPath = payload.outputPath ?? null;
    record.method = payload.method ?? null;
    record.error = null;
    record.updatedAt = new Date().toISOString();
    await upsertUpload(record);
    return { record, converted: true, payload };
  } catch (err) {
    record.status = 'failed';
    record.error = err instanceof Error ? err.message : String(err);
    record.updatedAt = new Date().toISOString();
    await upsertUpload(record);
    return { record, converted: false };
  }
}

export async function storeAndMaybeConvertDocument(session, sourcePath) {
  const record = await storeDocumentUpload(session, sourcePath);
  if (!documentsConverter(session)) {
    record.error = 'documents MCP is not connected';
    await upsertUpload(record);
    return { record, converted: false };
  }
  return convertStoredDocument(session, record.id);
}

export async function listDocumentUploads(session) {
  const workspace = requireWorkspace(session);
  return (await readManifest(workspace)).map(publicRecord);
}

export async function convertPendingDocumentUploads(session) {
  const workspace = requireWorkspace(session);
  const records = await readManifest(workspace);
  const pending = records.filter((record) => ['stored', 'failed'].includes(record.status));
  const results = [];
  for (const record of pending) {
    results.push(await convertStoredDocument(session, record.id));
  }
  return results;
}

function parseAgeMs(value = '30d') {
  const match = String(value).trim().match(/^(\d+)([dhm])$/i);
  if (!match) throw new Error('Invalid age. Use a value like 30d, 12h, or 90m.');
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 60 * 1000;
  return amount * factor;
}

export async function cleanDocumentUploads(session, olderThan = '30d') {
  const workspace = requireWorkspace(session);
  const cutoff = Date.now() - parseAgeMs(olderThan);
  const records = await readManifest(workspace);
  const keep = [];
  const removed = [];
  for (const record of records) {
    const created = Date.parse(record.createdAt || record.updatedAt || '');
    if (Number.isFinite(created) && created < cutoff) {
      removed.push(record);
      if (record.storedPath) {
        await rm(record.storedPath, { force: true }).catch(() => {});
      }
    } else {
      keep.push(record);
    }
  }
  if (removed.length > 0) await writeManifest(workspace, keep);
  return { removed, kept: keep };
}

export function formatUploadRecord(record) {
  const lines = [
    `${record.id}\t${record.status}\t${record.filename}`,
    `agentPath: ${record.agentPath}`,
  ];
  if (record.outputPath) lines.push(`outputPath: ${record.outputPath}`);
  if (record.method) lines.push(`method: ${record.method}`);
  if (record.error) lines.push(`note: ${record.error}`);
  return lines.join('\n');
}
