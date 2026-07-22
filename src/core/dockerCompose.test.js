import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

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
  assert.equal(agentsCompose.services.documents.environment.includes('DOCUMENT_LLM_BASE_URL=${DOCUMENT_LLM_BASE_URL:-https://albert.api.etalab.gouv.fr/v1}'), true);
  assert.equal(agentsCompose.services.documents.environment.includes('DOCUMENT_LLM_MODEL=${DOCUMENT_LLM_MODEL:-lightonai/LightOnOCR-2-1B}'), true);
  assert.equal(agentsCompose.services.documents.environment.includes('DOCUMENT_LLM_API_KEY=${DOCUMENT_LLM_API_KEY:-}'), true);
  // MailerSend was an external-connector experiment — removed from the
  // default stack (the agent repo still exists for ad-hoc use).
  assert.equal(agentsCompose.services.mailer, undefined);
});
