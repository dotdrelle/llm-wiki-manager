import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { managerMcpEndpointsFile } from './env.js';

const PROTECTED_SERVERS = new Set(['wiki', 'production', 'llm-wiki', 'wiki-production']);

function readDocument() {
  const filePath = managerMcpEndpointsFile();
  const raw = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mcp.endpoints.json must contain a JSON object.');
  }
  raw.mcpServers ??= {};
  raw.disabledMcpServers = Array.isArray(raw.disabledMcpServers)
    ? raw.disabledMcpServers.map(String).filter(Boolean)
    : [];
  raw.chatAccess ??= { maxToolIterations: 8, servers: {} };
  raw.chatAccess.servers ??= {};
  return { filePath, raw };
}

function writeDocument(filePath, raw) {
  const temporary = `${filePath}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
}

function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error('MCP server name must use letters, numbers, dots, underscores or hyphens.');
  }
  if (PROTECTED_SERVERS.has(name)) throw new Error(`Built-in MCP server cannot be changed: ${name}`);
  return name;
}

function normalizeUrl(value) {
  const url = String(value ?? '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('MCP server URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MCP server URL must use HTTP or HTTPS.');
  return url;
}

export function listManagedMcpEndpoints() {
  const { raw } = readDocument();
  return Object.entries(raw.mcpServers).map(([name, endpoint]) => ({
    name,
    url: String(endpoint?.url ?? ''),
    bearer: String(endpoint?.headers?.Authorization ?? endpoint?.headers?.authorization ?? '').replace(/^Bearer\s+/i, ''),
    allow: raw.chatAccess?.servers?.[name]?.allow ?? null,
  }));
}

export function upsertManagedMcpEndpoint({ name: rawName, previousName: rawPreviousName = null, url: rawUrl, bearer = '' } = {}) {
  const name = normalizeName(rawName);
  const previousName = rawPreviousName ? normalizeName(rawPreviousName) : name;
  const url = normalizeUrl(rawUrl);
  const { filePath, raw } = readDocument();
  if (previousName !== name && !Object.hasOwn(raw.mcpServers, previousName)) {
    throw new Error(`MCP server to rename was not found: ${previousName}`);
  }
  if (previousName !== name && Object.hasOwn(raw.mcpServers, name)) {
    throw new Error(`MCP server already exists: ${name}`);
  }
  const previous = raw.mcpServers[previousName] && typeof raw.mcpServers[previousName] === 'object'
    ? raw.mcpServers[previousName]
    : {};
  const headers = { ...(previous.headers ?? {}) };
  delete headers.authorization;
  delete headers.Authorization;
  if (String(bearer).trim()) headers.Authorization = `Bearer ${String(bearer).trim()}`;
  const managedBy = previous.managedBy === 'serve-ui' ? 'serve-ui' : (Object.keys(previous).length ? null : 'serve-ui');
  raw.mcpServers[name] = { ...previous, url, ...(managedBy ? { managedBy } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
  if (!Object.keys(headers).length) delete raw.mcpServers[name].headers;
  if (previousName !== name) {
    delete raw.mcpServers[previousName];
    delete raw.chatAccess.servers[previousName];
    if (!raw.disabledMcpServers.includes(previousName)) raw.disabledMcpServers.push(previousName);
  }
  raw.chatAccess.servers[name] = { allow: '*' };
  raw.disabledMcpServers = raw.disabledMcpServers.filter((item) => item !== name);
  writeDocument(filePath, raw);
  return { name, previousName, url, allow: '*', hasBearer: Boolean(String(bearer).trim()), origin: managedBy ? 'ui' : 'global' };
}

export function deleteManagedMcpEndpoint(rawName) {
  const name = normalizeName(rawName);
  const { filePath, raw } = readDocument();
  const existed = Object.hasOwn(raw.mcpServers, name);
  delete raw.mcpServers[name];
  delete raw.chatAccess.servers[name];
  if (!raw.disabledMcpServers.includes(name)) raw.disabledMcpServers.push(name);
  writeDocument(filePath, raw);
  return { name, deleted: existed };
}
