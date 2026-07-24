import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { configuredAgentImages } from './wikiSetup.js';

test('workspace compose does not start a per-workspace agent runtime', async () => {
  const raw = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  const compose = YAML.parse(raw);
  const aliases = compose['x-wiki-manager']['service-aliases'];

  assert.equal(compose.services['agent-runtime'], undefined);
  assert.deepEqual(aliases.all.targets, ['serve', 'mcp-http', 'production-mcp']);
  assert.equal(aliases.runtime, undefined);
  assert.equal(
    compose.services.serve.environment.includes('WIKI_MANAGER_RUNTIME_URL=http://host.docker.internal:${WIKI_MANAGER_RUNTIME_PORT:-7788}'),
    true,
  );
});

test('agent compose services run as the host uid and gid', async () => {
  const workspaceRaw = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  const workspaceCompose = YAML.parse(workspaceRaw);
  assert.equal(workspaceCompose.services['production-mcp'].user, '${UID:-1000}:${GID:-1000}');

  const agentsRaw = await readFile(new URL('../../agents.docker-compose.yml', import.meta.url), 'utf8');
  const agentsCompose = YAML.parse(agentsRaw);
  assert.equal(agentsCompose.services.cme.user, '${UID:-1000}:${GID:-1000}');
  assert.equal(agentsCompose.services.documents.user, '${UID:-1000}:${GID:-1000}');
  assert.equal(agentsCompose.services.connectors.user, '${UID:-1000}:${GID:-1000}');
  assert.deepEqual(agentsCompose.services.connectors.profiles, ['connectors']);
  assert.equal(agentsCompose.services.connectors.environment.includes('GOOGLE_OAUTH_CALLBACK_URL=${GOOGLE_OAUTH_CALLBACK_URL:-}'), true);
  assert.equal(agentsCompose.services.connectors.volumes.includes('${AGENTS_DATA_DIR:-./.agents-data}/connectors:/data'), true);
  assert.equal(agentsCompose.services.documents.environment.includes('DOCUMENT_LLM_BASE_URL=${DOCUMENT_LLM_BASE_URL:-https://albert.api.etalab.gouv.fr/v1}'), true);
  assert.equal(agentsCompose.services.documents.environment.includes('DOCUMENT_LLM_MODEL=${DOCUMENT_LLM_MODEL:-lightonai/LightOnOCR-2-1B}'), true);
  assert.equal(agentsCompose.services.documents.environment.includes('DOCUMENT_LLM_API_KEY=${DOCUMENT_LLM_API_KEY:-}'), true);
});

test('serve proxies connector OAuth through the host agent endpoint', async () => {
  const raw = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  const compose = YAML.parse(raw);
  assert.equal(compose.services.serve.environment.includes('CONNECTORS_AGENT_URL=http://host.docker.internal:${CONNECTORS_MCP_PORT:-3338}'), true);
  assert.equal(compose.services.serve.environment.includes('CONNECTORS_OAUTH_START_TOKEN=${OAUTH_START_TOKEN:-}'), true);
});

test('missing-image checks ignore agents behind inactive Compose profiles', () => {
  const compose = {
    services: {
      cme: { image: 'example/cme:latest' },
      connectors: { image: 'example/connectors:latest', profiles: ['connectors'] },
    },
  };

  assert.deepEqual(configuredAgentImages(compose), ['example/cme:latest']);
  assert.deepEqual(
    configuredAgentImages(compose, new Set(['connectors'])),
    ['example/cme:latest', 'example/connectors:latest'],
  );
});
