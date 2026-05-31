import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './env.js';
import { managerRoot } from './workspaces.js';

function readManagerEnv() {
  const envPath = join(managerRoot(), '.env');
  return existsSync(envPath) ? readEnvFile(envPath) : {};
}

function endpointStatus(configured, detail = '') {
  return {
    status: configured ? 'configured' : 'missing',
    detail,
  };
}

const MCP_SERVICE_MAP = {
  wiki: 'mcp-http',
  cme: 'cme-mcp',
  production: 'production-mcp',
};

export function buildMcpStatus(session) {
  const workspaceEnv = session.workspaceEnv ?? {};
  const managerEnv = readManagerEnv();

  return {
    wiki: {
      ...endpointStatus(
        workspaceEnv.WIKI_MCP_PORT && workspaceEnv.WIKI_MCP_AUTH_TOKEN,
        workspaceEnv.WIKI_MCP_PORT ? `:${workspaceEnv.WIKI_MCP_PORT}` : '',
      ),
      url: workspaceEnv.WIKI_MCP_PORT ? `http://127.0.0.1:${workspaceEnv.WIKI_MCP_PORT}/mcp` : null,
      token: workspaceEnv.WIKI_MCP_AUTH_TOKEN || null,
    },
    cme: {
      ...endpointStatus(
        workspaceEnv.CME_MCP_PORT && workspaceEnv.CME_MCP_AUTH_TOKEN,
        workspaceEnv.CME_MCP_PORT ? `:${workspaceEnv.CME_MCP_PORT}` : '',
      ),
      url: workspaceEnv.CME_MCP_PORT ? `http://127.0.0.1:${workspaceEnv.CME_MCP_PORT}/mcp/` : null,
      token: workspaceEnv.CME_MCP_AUTH_TOKEN || null,
    },
    production: {
      ...endpointStatus(
        workspaceEnv.PRODUCTION_MCP_PORT && workspaceEnv.PRODUCTION_MCP_AUTH_TOKEN,
        workspaceEnv.PRODUCTION_MCP_PORT ? `:${workspaceEnv.PRODUCTION_MCP_PORT}` : '',
      ),
      url: workspaceEnv.PRODUCTION_MCP_PORT ? `http://127.0.0.1:${workspaceEnv.PRODUCTION_MCP_PORT}/mcp/` : null,
      token: workspaceEnv.PRODUCTION_MCP_AUTH_TOKEN || null,
    },
    mailer: {
      ...endpointStatus(managerEnv.MAILER_MCP_PROXY_URL && managerEnv.MAILER_MCP_AUTH_TOKEN),
      url: managerEnv.MAILER_MCP_PROXY_URL || null,
      token: managerEnv.MAILER_MCP_AUTH_TOKEN || null,
    },
    documents: {
      ...endpointStatus(managerEnv.DOCUMENTS_MCP_PROXY_URL && managerEnv.DOCUMENTS_MCP_AUTH_TOKEN),
      url: managerEnv.DOCUMENTS_MCP_PROXY_URL || null,
      token: managerEnv.DOCUMENTS_MCP_AUTH_TOKEN || null,
    },
    atlassian: {
      ...endpointStatus(managerEnv.ATLASSIAN_MCP_PROXY_URL && managerEnv.ATLASSIAN_MCP_AUTH_TOKEN),
      url: managerEnv.ATLASSIAN_MCP_PROXY_URL || null,
      token: managerEnv.ATLASSIAN_MCP_AUTH_TOKEN || null,
    },
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
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const data = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
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
      'Production export means wiki deliverable/publication export only. Do not use type=export for Confluence/CME/source export; use cme_export_run instead.',
    ].filter(Boolean).join(' '));
  }
  return base;
}

async function listMcpTools(endpoint) {
  if (!endpoint.url || !endpoint.token) throw new Error('missing endpoint URL or token');
  const payload = await mcpRequest(endpoint, 'tools/list', {});
  return payload?.result?.tools ?? [];
}

async function mcpRequest(endpoint, method, params) {
  if (!endpoint.url || !endpoint.token) throw new Error('missing endpoint URL or token');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const buildHeaders = () => {
    const h = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
    };
    if (endpoint._sessionId) h['mcp-session-id'] = endpoint._sessionId;
    return h;
  };

  const doRequest = async (m, p) => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      signal: controller.signal,
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
        signal: controller.signal,
        headers: buildHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'wiki-manager', version: '0.1.0' },
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

export async function callMcpTool(mcpStatus, serverName, toolName, args = {}) {
  const endpoint = mcpStatus?.[serverName];
  if (!endpoint) throw new Error(`Unknown MCP: ${serverName}`);
  if (endpoint.status !== 'connected') throw new Error(`MCP is not connected: ${serverName}`);
  const payload = await mcpRequest(endpoint, 'tools/call', {
    name: toolName,
    arguments: args,
  });
  if (payload?.result?.isError) {
    throw new Error(formatMcpToolResult(payload.result));
  }
  return payload?.result ?? null;
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
    sections.push(`${name}: ${tools.map((tool) => tool.name).join(', ')}`);
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
