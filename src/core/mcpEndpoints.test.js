import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deleteManagedMcpEndpoint, listManagedMcpEndpoints, upsertManagedMcpEndpoint } from './mcpEndpoints.js';
import { buildMcpStatus, discoverMcpTools, resetMcpSessionsForTests } from './mcp.js';
import { chatAllowedTools } from '../shell/repl.js';
import { buildAgentSystemPrompt } from '../agent/graph.js';

async function withEndpoints(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-mcp-endpoints-'));
  const envFile = join(root, '.env');
  writeFileSync(envFile, '', 'utf8');
  writeFileSync(join(root, 'mcp.endpoints.json'), JSON.stringify({
    mcpServers: { cme: { url: 'http://localhost:3336/mcp/' } },
    chatAccess: { maxToolIterations: 8, servers: { cme: { allow: ['cme_status'] } } },
  }), 'utf8');
  const previous = process.env.WIKI_MANAGER_ENV_FILE;
  process.env.WIKI_MANAGER_ENV_FILE = envFile;
  try { await fn(root); } finally {
    if (previous === undefined) delete process.env.WIKI_MANAGER_ENV_FILE;
    else process.env.WIKI_MANAGER_ENV_FILE = previous;
  }
}

test('UI-managed MCP endpoints persist with bearer auth and chat wildcard access', async () => {
  await withEndpoints(async (root) => {
    upsertManagedMcpEndpoint({ name: 'exa', url: 'https://mcp.exa.ai/mcp', bearer: 'secret' });
    const raw = JSON.parse(readFileSync(join(root, 'mcp.endpoints.json'), 'utf8'));
    assert.equal(raw.mcpServers.exa.url, 'https://mcp.exa.ai/mcp');
    assert.equal(raw.mcpServers.exa.headers.Authorization, 'Bearer secret');
    assert.equal(raw.chatAccess.servers.exa.allow, '*');
    assert.deepEqual(listManagedMcpEndpoints().find((item) => item.name === 'exa'), {
      name: 'exa', url: 'https://mcp.exa.ai/mcp', bearer: 'secret', allow: '*',
    });
  });
});

test('deleting an external MCP removes endpoint and chat access without touching others', async () => {
  await withEndpoints(async (root) => {
    upsertManagedMcpEndpoint({ name: 'exa', url: 'https://mcp.exa.ai/mcp' });
    assert.equal(deleteManagedMcpEndpoint('cme').deleted, true);
    const raw = JSON.parse(readFileSync(join(root, 'mcp.endpoints.json'), 'utf8'));
    assert.equal(raw.mcpServers.cme, undefined);
    assert.equal(raw.chatAccess.servers.cme, undefined);
    assert.deepEqual(raw.disabledMcpServers, ['cme']);
    assert.equal(raw.mcpServers.exa.url, 'https://mcp.exa.ai/mcp');
    upsertManagedMcpEndpoint({ name: 'cme', url: 'http://localhost:3336/mcp/' });
    const restored = JSON.parse(readFileSync(join(root, 'mcp.endpoints.json'), 'utf8'));
    assert.deepEqual(restored.disabledMcpServers, []);
  });
});

test('built-in workspace MCP endpoints cannot be changed from the connectors UI', async () => {
  await withEndpoints(async () => {
    assert.throws(() => deleteManagedMcpEndpoint('llm-wiki'), /cannot be changed/);
    assert.throws(
      () => upsertManagedMcpEndpoint({ name: 'wiki-production', url: 'https://example.test/mcp' }),
      /cannot be changed/,
    );
  });
});

test('renaming a persisted MCP moves endpoint, chat access and deletion identity atomically', async () => {
  await withEndpoints(async (root) => {
    upsertManagedMcpEndpoint({ name: 'exa', url: 'https://mcp.exa.ai/mcp', bearer: 'first' });
    const renamed = upsertManagedMcpEndpoint({
      name: 'exa-search', previousName: 'exa', url: 'https://mcp.exa.ai/mcp', bearer: 'second',
    });
    assert.equal(renamed.previousName, 'exa');
    const raw = JSON.parse(readFileSync(join(root, 'mcp.endpoints.json'), 'utf8'));
    assert.equal(raw.mcpServers.exa, undefined);
    assert.equal(raw.chatAccess.servers.exa, undefined);
    assert.equal(raw.mcpServers['exa-search'].headers.Authorization, 'Bearer second');
    assert.equal(raw.chatAccess.servers['exa-search'].allow, '*');
    assert.ok(raw.disabledMcpServers.includes('exa'));
  });
});

test('a UI-added MCP is rediscovered for both chat wildcard and direct agent tools', async () => {
  await withEndpoints(async () => {
    upsertManagedMcpEndpoint({ name: 'exa', url: 'https://mcp.exa.ai/mcp', bearer: 'secret' });
    const originalFetch = globalThis.fetch;
    const seenAuthorization = [];
    resetMcpSessionsForTests();
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      seenAuthorization.push(init.headers.authorization);
      if (body.method === 'initialize') {
        return {
          ok: true, status: 200,
          headers: { get: (name) => name === 'mcp-session-id' ? 'exa-session' : null },
          text: async () => '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}',
        };
      }
      if (body.method === 'notifications/initialized') {
        return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({
          jsonrpc: '2.0', id: 2,
          result: { tools: [
            { name: 'web_search_exa', inputSchema: { type: 'object', properties: {} } },
            { name: 'get_code_context_exa', inputSchema: { type: 'object', properties: {} } },
          ] },
        }),
      };
    };
    try {
      const session = { workspace: 'docs', workspaceEnv: {}, wikircConfig: {}, commands: [] };
      session.mcp = await discoverMcpTools(buildMcpStatus(session));
      const chatTools = chatAllowedTools(session).map((tool) => tool.function.name).sort();
      assert.deepEqual(chatTools, ['exa__get_code_context_exa', 'exa__web_search_exa']);
      const agentPrompt = buildAgentSystemPrompt({ session });
      assert.match(agentPrompt, /exa__web_search_exa/);
      assert.match(agentPrompt, /exa__get_code_context_exa/);
      assert.ok(seenAuthorization.includes('Bearer secret'));
    } finally {
      globalThis.fetch = originalFetch;
      resetMcpSessionsForTests();
    }
  });
});
