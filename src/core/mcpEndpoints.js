import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// Written IN PLACE, never temp + rename: every workspace's serve container
// bind-mounts this single file, and a bind mount follows the inode. A rename
// left each container on the deleted copy — `/mcp.endpoints.json` became
// unreadable, and every external MCP (cme, documents, connectors…) vanished
// from serve after a maintenance mode switch or a connector edit.
function writeDocument(filePath, raw) {
  writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
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

/* The Connectors panel needs a display/edit URL, but never credentials, query
 * values or fragments. When it sends this exact projection back unchanged,
 * upsertManagedMcpEndpoint keeps the original URL in the manager's file. */
function browserSafeUrl(value) {
  const raw = String(value ?? '');
  try {
    const url = new URL(raw);
    const hasUrlSecrets = Boolean(url.username || url.password || url.search || url.hash);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { url: url.toString(), hasUrlSecrets };
  } catch {
    return { url: '', hasUrlSecrets: Boolean(raw) };
  }
}

function normalizeTimeoutMs(value, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return null;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new Error('MCP timeout must be between 1000 and 120000 milliseconds.');
  }
  return timeoutMs;
}

export function listManagedMcpEndpoints() {
  const { raw } = readDocument();
  return Object.entries(raw.mcpServers).map(([name, endpoint]) => ({
    name,
    ...browserSafeUrl(endpoint?.url),
    // Listed to the served Connectors panel: whether a token is set, never the token.
    hasBearer: /^Bearer\s+\S/i.test(String(endpoint?.headers?.Authorization ?? endpoint?.headers?.authorization ?? '')),
    timeoutMs: Number.isInteger(endpoint?.timeoutMs) && endpoint.timeoutMs >= 1000 && endpoint.timeoutMs <= 120_000
      ? endpoint.timeoutMs
      : null,
    allow: raw.chatAccess?.servers?.[name]?.allow ?? null,
  }));
}

// `bearer`: a string replaces the token ('' removes it); omitted, the saved
// token is kept — the browser no longer holds it, so a rename or a URL change
// must not erase it.
export function upsertManagedMcpEndpoint({ name: rawName, previousName: rawPreviousName = null, url: rawUrl, bearer, timeoutMs: rawTimeoutMs } = {}) {
  const name = normalizeName(rawName);
  const previousName = rawPreviousName ? normalizeName(rawPreviousName) : name;
  const submittedUrl = normalizeUrl(rawUrl);
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
  const previousUrl = String(previous.url ?? '');
  // The browser sends the redacted URL for an unchanged endpoint. Retain its
  // server-side query/userinfo instead of silently replacing a working URL.
  const url = previousUrl && submittedUrl === browserSafeUrl(previousUrl).url
    ? previousUrl
    : submittedUrl;
  const timeoutMs = rawTimeoutMs === undefined
    ? (Number.isInteger(previous.timeoutMs) && previous.timeoutMs >= 1000 && previous.timeoutMs <= 120_000 ? previous.timeoutMs : null)
    : normalizeTimeoutMs(rawTimeoutMs, { optional: true });
  const headers = { ...(previous.headers ?? {}) };
  if (bearer !== undefined && bearer !== null) {
    delete headers.authorization;
    delete headers.Authorization;
    if (String(bearer).trim()) headers.Authorization = `Bearer ${String(bearer).trim()}`;
  }
  const managedBy = previous.managedBy === 'serve-ui' ? 'serve-ui' : (Object.keys(previous).length ? null : 'serve-ui');
  raw.mcpServers[name] = {
    ...previous,
    url,
    ...(timeoutMs == null ? {} : { timeoutMs }),
    ...(managedBy ? { managedBy } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
  if (timeoutMs == null) delete raw.mcpServers[name].timeoutMs;
  if (!Object.keys(headers).length) delete raw.mcpServers[name].headers;
  if (previousName !== name) {
    delete raw.mcpServers[previousName];
    delete raw.chatAccess.servers[previousName];
    if (!raw.disabledMcpServers.includes(previousName)) raw.disabledMcpServers.push(previousName);
  }
  raw.chatAccess.servers[name] = { allow: '*' };
  raw.disabledMcpServers = raw.disabledMcpServers.filter((item) => item !== name);
  writeDocument(filePath, raw);
  return { name, previousName, ...browserSafeUrl(url), timeoutMs, allow: '*', hasBearer: /^Bearer\s+\S/i.test(String(headers.Authorization ?? headers.authorization ?? '')), origin: managedBy ? 'ui' : 'global' };
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

export function readMaintenanceAccessDocument() { return readDocument().raw; }

/**
 * Turn automatic maintenance on or off for ONE workspace. Only
 * `maintenanceAccess.workspaces.<name>.enabled` is written: the operator's
 * other settings (actions, limits, build window, mail) are left as they are.
 * The resulting policy is validated by the caller before this write is kept
 * (see maintenance/service.js setEnabled).
 */
export function setMaintenanceEnabled(rawWorkspace, enabled) {
  const workspace = normalizeName(rawWorkspace);
  const { filePath, raw } = readDocument();
  const before = JSON.stringify(raw.maintenanceAccess ?? null);
  raw.maintenanceAccess ??= { defaults: { enabled: false }, workspaces: {} };
  if (!raw.maintenanceAccess || typeof raw.maintenanceAccess !== 'object' || Array.isArray(raw.maintenanceAccess)) {
    throw new Error('maintenanceAccess must be a JSON object.');
  }
  raw.maintenanceAccess.workspaces ??= {};
  raw.maintenanceAccess.workspaces[workspace] = { ...(raw.maintenanceAccess.workspaces[workspace] ?? {}), enabled: Boolean(enabled) };
  writeDocument(filePath, raw);
  return { workspace, enabled: Boolean(enabled), previous: before };
}

/** Persist the workspace's automatic or approval-gated maintenance mode. */
export function setMaintenanceMode(rawWorkspace, mode) {
  const workspace = normalizeName(rawWorkspace);
  if (!['auto', 'human'].includes(mode)) throw new Error('Maintenance mode must be auto or human.');
  const { filePath, raw } = readDocument();
  raw.maintenanceAccess ??= { defaults: { enabled: false }, workspaces: {} };
  if (!raw.maintenanceAccess || typeof raw.maintenanceAccess !== 'object' || Array.isArray(raw.maintenanceAccess)) {
    throw new Error('maintenanceAccess must be a JSON object.');
  }
  raw.maintenanceAccess.workspaces ??= {};
  raw.maintenanceAccess.workspaces[workspace] = { ...(raw.maintenanceAccess.workspaces[workspace] ?? {}), mode };
  writeDocument(filePath, raw);
  return { workspace, mode };
}
