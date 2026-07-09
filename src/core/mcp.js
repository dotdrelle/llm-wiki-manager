import { existsSync, readFileSync } from 'node:fs';
import { managerEnvFile, managerMcpEndpointsFile, readEnvFile } from './env.js';

const WIKI_MANAGER_VERSION = '0.12.3';

function envValue(key) {
  const filePath = managerEnvFile();
  if (existsSync(filePath)) {
    const fileValue = readEnvFile(filePath)[key];
    if (fileValue !== undefined) return fileValue;
  }
  return process.env[key];
}

function interpolateEnv(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const sep = expr.indexOf(':-');
    if (sep !== -1) return envValue(expr.slice(0, sep)) ?? expr.slice(sep + 2);
    return envValue(expr) ?? '';
  });
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key, value]) => key && typeof value === 'string' && value)
      .map(([key, value]) => [key.toLowerCase(), interpolateEnv(value)]),
  );
}

function normalizeExternalUrlForRuntime(url) {
  if (process.env.WIKI_MANAGER_KEEP_DOCKER_HOST === '1') return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'host.docker.internal') {
      parsed.hostname = 'localhost';
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

function readExternalMcpEndpoints() {
  const filePath = managerMcpEndpointsFile();
  if (!existsSync(filePath)) return {};
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const servers = raw?.mcpServers ?? raw?.servers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return Object.fromEntries(
    Object.entries(servers)
      .filter(([, endpoint]) => endpoint?.url)
      .map(([name, endpoint]) => [
        name,
        {
          ...endpointStatus(true),
          url: normalizeExternalUrlForRuntime(interpolateEnv(String(endpoint.url))),
          configuredUrl: interpolateEnv(String(endpoint.url)),
          headers: normalizeHeaders(endpoint.headers),
          external: true,
        },
      ]),
  );
}

function endpointStatus(configured, detail = '') {
  return {
    status: configured ? 'configured' : 'missing',
    detail,
  };
}

function approvalToolsFor(serverName) {
  const raw = envValue('WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS');
  if (!raw) return undefined;
  const tools = String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item === '*' || item.startsWith(`${serverName}.`) || !item.includes('.'))
    .map((item) => item.startsWith(`${serverName}.`) ? item.slice(serverName.length + 1) : item);
  return tools.length > 0 ? tools : undefined;
}

const MCP_SERVICE_MAP = {
  wiki: 'mcp-http',
  production: 'production-mcp',
};

const DEFAULT_MCP_RETRY_POLICY = {
  maxAttempts: 2,
  backoffMs: 500,
};

export function buildMcpStatus(session) {
  const workspaceEnv = session.workspaceEnv ?? {};
  const wikiMcpToken = session.wikircConfig?.mcp?.accessKey;
  const wikiMcpDetail = workspaceEnv.WIKI_MCP_PORT
    ? (wikiMcpToken ? `:${workspaceEnv.WIKI_MCP_PORT}` : `:${workspaceEnv.WIKI_MCP_PORT} (mcp.accessKey missing in active wikirc)`)
    : '';
  const external = readExternalMcpEndpoints();

  return {
    wiki: {
      ...endpointStatus(
        workspaceEnv.WIKI_MCP_PORT && wikiMcpToken,
        wikiMcpDetail,
      ),
      url: workspaceEnv.WIKI_MCP_PORT ? `http://127.0.0.1:${workspaceEnv.WIKI_MCP_PORT}/mcp` : null,
      token: wikiMcpToken || null,
      requireApproval: approvalToolsFor('wiki'),
    },
    production: {
      ...endpointStatus(
        workspaceEnv.PRODUCTION_MCP_PORT && workspaceEnv.PRODUCTION_MCP_AUTH_TOKEN,
        workspaceEnv.PRODUCTION_MCP_PORT ? `:${workspaceEnv.PRODUCTION_MCP_PORT}` : '',
      ),
      url: workspaceEnv.PRODUCTION_MCP_PORT ? `http://127.0.0.1:${workspaceEnv.PRODUCTION_MCP_PORT}/mcp/` : null,
      token: workspaceEnv.PRODUCTION_MCP_AUTH_TOKEN || null,
      activeConfigPath: session.wikirc?.fileName || null,
      requireApproval: approvalToolsFor('production'),
    },
    ...external,
  };
}

export function applyMcpRuntimeStatus(mcpStatus, serviceStates = {}) {
  const next = {};
  for (const [name, value] of Object.entries(mcpStatus ?? {})) {
    const service = MCP_SERVICE_MAP[name];
    if (!service || value.status === 'missing') {
      next[name] = value;
      continue;
    }
    const runtime = serviceStates[service];
    next[name] = {
      ...value,
      status: runtime?.running ? 'connected' : 'configured',
      runtime: runtime?.state || 'not running',
    };
  }
  return next;
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  if (dataLines.length > 0) {
    const data = dataLines.join('\n');
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(trimmed);
}

function compactDescription(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 420 ? `${text.slice(0, 417)}...` : text;
}

function clarifyToolDescription(serverName, toolName, description) {
  const base = compactDescription(description ?? '');
  if (serverName === 'cme' && toolName.startsWith('cme_export')) {
    return compactDescription([
      base,
      'Use only for Confluence/CME/source export into raw/untracked. Not for wiki deliverable export.',
    ].filter(Boolean).join(' '));
  }
  if (serverName === 'production' && toolName === 'production_start_job') {
    return compactDescription([
      base,
      'Production export means wiki deliverable/publication export only. Do not use type=export for Confluence/CME/source export; use cme__cme_export_run instead.',
    ].filter(Boolean).join(' '));
  }
  return base;
}

async function listMcpTools(endpoint) {
  if (!endpoint.url) throw new Error('missing endpoint URL');
  const payload = await mcpRequest(endpoint, 'tools/list', {});
  return payload?.result?.tools ?? [];
}

async function mcpRequest(endpoint, method, params, signal, options = {}) {
  if (!endpoint.url) throw new Error('missing endpoint URL');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  const buildHeaders = () => {
    const h = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(endpoint.headers ?? {}),
    };
    if (endpoint.token) h.authorization = `Bearer ${endpoint.token}`;
    if (endpoint._sessionId) h['mcp-session-id'] = endpoint._sessionId;
    return h;
  };

  const doRequest = async (m, p) => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      signal: requestSignal,
      headers: buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
    });
    const sid = response.headers.get('mcp-session-id');
    if (sid) endpoint._sessionId = sid;
    return response;
  };

  try {
    let response = await doRequest(method, params);
    let text = await response.text();

    if (response.status === 400 && /session ID/i.test(text)) {
      endpoint._sessionId = null;
      const initResponse = await fetch(endpoint.url, {
        method: 'POST',
        signal: requestSignal,
        headers: buildHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'wiki-manager', version: WIKI_MANAGER_VERSION },
          },
        }),
      });
      await initResponse.text();
      const sessionId = initResponse.headers.get('mcp-session-id');
      if (!initResponse.ok || !sessionId) {
        throw new Error(`initialize failed: ${initResponse.status}`);
      }
      endpoint._sessionId = sessionId;
      // Fire-and-forget: complete the handshake without blocking the retry
      fetch(endpoint.url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      }).catch(() => {});
      response = await doRequest(method, params);
      text = await response.text();
    }

    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 160)}`.trim());
    const payload = parseMcpResponse(text);
    if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callMcpTool(mcpStatus, serverName, toolName, args = {}, signal, options = {}) {
  const endpoint = mcpStatus?.[serverName];
  if (!endpoint) throw new Error(`Unknown MCP: ${serverName}`);
  if (endpoint.status !== 'connected') throw new Error(`MCP is not connected: ${serverName}`);
  const shouldInjectConfigPath =
    serverName === 'production' &&
    toolName === 'production_start_job' &&
    endpoint.activeConfigPath &&
    !args.configPath;
  const toolArgs = {
    ...args,
    ...(shouldInjectConfigPath ? { configPath: endpoint.activeConfigPath } : {}),
  };
  const timeoutMs = serverName === 'documents' && toolName === 'documents_convert_to_markdown' ? 600_000 : 8000;
  const retry = resolveRetryPolicy(endpoint, toolName, options.retry);
  return withRetry(async () => {
    const payload = await mcpRequest(endpoint, 'tools/call', {
      name: toolName,
      arguments: toolArgs,
    }, signal, { timeoutMs });
    if (payload?.result?.isError) {
      throw new Error(formatMcpToolResult(payload.result));
    }
    return payload?.result ?? null;
  }, retry, { signal, onRetry: options.onRetry });
}

export function formatMcpToolResult(result) {
  if (!result) return 'No result.';
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result, null, 2);
  return content
    .map((item) => {
      if (item.type === 'text') return item.text ?? '';
      return JSON.stringify(item, null, 2);
    })
    .filter(Boolean)
    .join('\n\n')
    .trim() || 'No result.';
}

const DEFAULT_TOOL_RESULT_MAX_CHARS = 16000;

function toolResultMaxChars() {
  const parsed = Number(process.env.WIKI_MANAGER_TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TOOL_RESULT_MAX_CHARS;
}

// Bound what a tool result injects into the LLM context and the conversation
// display. Apply this ONLY at those two exit points — never before payload
// parsing (extractActivity/_activity detection needs the full text).
// Head + tail are kept because errors and job ids often live at either end.
export function truncateToolResult(text, maxChars = toolResultMaxChars()) {
  const full = String(text ?? '');
  if (full.length <= maxChars) return full;
  const headLength = Math.floor(maxChars * 0.7);
  const tailLength = Math.floor(maxChars * 0.2);
  const omitted = full.length - headLength - tailLength;
  return `${full.slice(0, headLength)}\n\n[… ${omitted} caractères tronqués — résultat complet dans les logs runtime …]\n\n${full.slice(-tailLength)}`;
}

let _cachedEnvRetryPolicy = null;
function getEnvRetryPolicy() {
  if (!_cachedEnvRetryPolicy) {
    _cachedEnvRetryPolicy = {
      maxAttempts: numberFromEnv('WIKI_MANAGER_MCP_RETRY_MAX_ATTEMPTS')
        ?? numberFromEnv('WIKI_MANAGER_MCP_RETRY_ATTEMPTS')
        ?? DEFAULT_MCP_RETRY_POLICY.maxAttempts,
      backoffMs: numberFromEnv('WIKI_MANAGER_MCP_RETRY_BACKOFF_MS')
        ?? DEFAULT_MCP_RETRY_POLICY.backoffMs,
    };
  }
  return _cachedEnvRetryPolicy;
}

export function resolveRetryPolicy(endpoint = {}, toolName = null, override = null) {
  const toolPolicy = toolName ? endpoint.toolRetries?.[toolName] : null;
  return normalizeRetryPolicy(getEnvRetryPolicy(), endpoint.retry, toolPolicy, override);
}

function normalizeRetryPolicy(...policies) {
  const merged = {};
  for (const policy of policies) {
    if (policy === false) {
      merged.maxAttempts = 1;
      continue;
    }
    if (!policy || typeof policy !== 'object') continue;
    if (policy.maxAttempts != null) merged.maxAttempts = Number(policy.maxAttempts);
    if (policy.backoffMs != null) merged.backoffMs = Number(policy.backoffMs);
  }
  const maxAttempts = Number.isFinite(merged.maxAttempts)
    ? Math.max(1, Math.floor(merged.maxAttempts))
    : DEFAULT_MCP_RETRY_POLICY.maxAttempts;
  const backoffMs = Number.isFinite(merged.backoffMs)
    ? Math.max(0, Math.floor(merged.backoffMs))
    : DEFAULT_MCP_RETRY_POLICY.backoffMs;
  return { maxAttempts, backoffMs };
}

function numberFromEnv(key) {
  const raw = envValue(key);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function withRetry(operation, policy, { signal = null, onRetry = null } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation({ attempt });
    } catch (err) {
      lastError = err;
      if (attempt >= policy.maxAttempts || signal?.aborted) throw err;
      onRetry?.({ attempt, maxAttempts: policy.maxAttempts, error: err });
      await retryDelay(policy.backoffMs * (2 ** (attempt - 1)), signal);
    }
  }
  throw lastError;
}

function retryDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('Operation aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function discoverMcpTools(mcpStatus) {
  const next = {};
  await Promise.all(Object.entries(mcpStatus ?? {}).map(async ([name, value]) => {
    if (value.status === 'missing') {
      next[name] = value;
      return;
    }
    try {
      const tools = await listMcpTools(value);
      next[name] = {
        ...value,
        status: 'connected',
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        })),
        toolError: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      next[name] = {
        ...value,
        status: value.status === 'connected' ? 'configured' : value.status,
        tools: [],
        toolError: message,
      };
    }
  }));
  return next;
}

export function formatMcpTools(mcpStatus, filterName = null) {
  const lines = [];
  const entries = Object.entries(mcpStatus ?? {}).filter(([name]) => !filterName || name === filterName);
  for (const [name, value] of entries) {
    if (value.status !== 'connected') continue;
    const tools = value.tools ?? [];
    lines.push(`### ${name}`, '');
    if (tools.length === 0) {
      lines.push('No tools discovered.', '');
      continue;
    }
    for (const tool of tools.slice(0, 20)) {
      lines.push(`**Tool:** \`${tool.name}\``);
      lines.push(`**Description:** ${compactDescription(tool.description ?? '') || '-'}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    if (tools.length > 20) {
      lines.push(`_${tools.length - 20} more tools hidden._`, '');
    }
  }
  if (lines.length > 0) return lines.join('\n').trimEnd();
  return filterName
    ? `No connected MCP tools discovered for ${filterName}.`
    : 'No connected MCP tools discovered.';
}

export function formatMcpToolSummary(mcpStatus) {
  const lines = [];
  for (const [name, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    const count = value.tools?.length ?? 0;
    lines.push(`- ${name}: ${count} tool${count === 1 ? '' : 's'}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'No connected MCP tools discovered.';
}

export function formatMcpToolsForAgent(mcpStatus) {
  const sections = [];
  for (const [name, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    const tools = value.tools ?? [];
    if (tools.length === 0) {
      sections.push(`${name}: connected, tools not discovered yet`);
      continue;
    }
    // Always advertise the qualified call name (server__tool): showing bare
    // tool names here is what teaches the model to emit unqualified calls.
    sections.push(`${name}: ${tools.map((tool) => `${name}__${tool.name}`).join(', ')}`);
  }
  return sections.length > 0 ? sections.join('\n') : 'No connected MCP tools discovered yet.';
}

export function buildLlmTools(mcpStatus) {
  const tools = [];
  for (const [serverName, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    for (const tool of value.tools ?? []) {
      tools.push({
        type: 'function',
        function: {
          name: `${serverName}__${tool.name}`,
          description: clarifyToolDescription(serverName, tool.name, tool.description),
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return tools;
}

export function parseToolCallName(name) {
  const sep = name.indexOf('__');
  if (sep === -1) return { server: null, tool: name };
  return { server: name.slice(0, sep), tool: name.slice(sep + 2) };
}

// Deterministic recovery for unqualified tool-call names emitted by the LLM
// (e.g. "cme_status" instead of "cme__cme_status"). Exact-name match only:
// if exactly one connected server (or extra pseudo-server) exposes the bare
// tool name, route to it and report `normalized: true`; otherwise return
// `server: null` with the list of candidate servers so the caller can raise
// an explicit error. This is name normalization, never fuzzy matching — do
// not extend it to description/similarity-based selection (plan directeur
// §20 forbids that).
export function resolveToolCallName(mcpStatus, name, extraServers = {}) {
  const parsed = parseToolCallName(name);
  if (parsed.server) return { ...parsed, normalized: false, candidates: [] };
  const candidates = [];
  for (const [serverName, toolNames] of Object.entries(extraServers)) {
    if (toolNames.includes(parsed.tool)) candidates.push(serverName);
  }
  for (const [serverName, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    if ((value.tools ?? []).some((tool) => tool.name === parsed.tool)) candidates.push(serverName);
  }
  if (candidates.length === 1) {
    return { server: candidates[0], tool: parsed.tool, normalized: true, candidates };
  }
  return { server: null, tool: parsed.tool, normalized: false, candidates };
}

export function mcpStatusMarker(status) {
  if (status === 'connected') return '●';
  if (status === 'configured') return '◐';
  return '○';
}

export function formatMcpStatus(mcpStatus) {
  const entries = Object.entries(mcpStatus ?? {});
  if (entries.length === 0) return '○ none';
  return entries
    .map(([name, value]) => {
      const marker = mcpStatusMarker(value.status);
      const detail = [value.status, value.detail, value.runtime ? `(${value.runtime})` : '']
        .filter(Boolean)
        .join(' ');
      const tools = value.tools ? ` tools=${value.tools.length}` : '';
      const error = value.toolError ? ` toolsError=${value.toolError}` : '';
      return `${marker} ${name}${detail ? ` ${detail}` : ''}${tools}${error}`;
    })
    .join('\n');
}
