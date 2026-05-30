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

export function buildMcpStatus(session) {
  const workspaceEnv = session.workspaceEnv ?? {};
  const managerEnv = readManagerEnv();

  return {
    wiki: endpointStatus(
      workspaceEnv.WIKI_MCP_PORT && workspaceEnv.WIKI_MCP_AUTH_TOKEN,
      workspaceEnv.WIKI_MCP_PORT ? `:${workspaceEnv.WIKI_MCP_PORT}` : '',
    ),
    cme: endpointStatus(
      workspaceEnv.CME_MCP_PORT && workspaceEnv.CME_MCP_AUTH_TOKEN,
      workspaceEnv.CME_MCP_PORT ? `:${workspaceEnv.CME_MCP_PORT}` : '',
    ),
    production: endpointStatus(
      workspaceEnv.PRODUCTION_MCP_PORT && workspaceEnv.PRODUCTION_MCP_AUTH_TOKEN,
      workspaceEnv.PRODUCTION_MCP_PORT ? `:${workspaceEnv.PRODUCTION_MCP_PORT}` : '',
    ),
    mailer: endpointStatus(managerEnv.MAILER_MCP_PROXY_URL && managerEnv.MAILER_MCP_AUTH_TOKEN),
    documents: endpointStatus(managerEnv.DOCUMENTS_MCP_PROXY_URL && managerEnv.DOCUMENTS_MCP_AUTH_TOKEN),
    atlassian: endpointStatus(managerEnv.ATLASSIAN_MCP_PROXY_URL && managerEnv.ATLASSIAN_MCP_AUTH_TOKEN),
  };
}

export function formatMcpStatus(mcpStatus) {
  const entries = Object.entries(mcpStatus ?? {});
  if (entries.length === 0) return '○ none';
  return entries
    .map(([name, value]) => {
      const marker = value.status === 'connected' ? '●' : value.status === 'configured' ? '●' : '●';
      return `${marker} ${name}${value.detail ? ` ${value.detail}` : ''}`;
    })
    .join('\n');
}
