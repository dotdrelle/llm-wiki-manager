import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { configuredAgentImages } from './wikiSetup.js';
import { REQUIRED_ENV_KEYS } from './env.js';

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

test('no compose service relies on a bare environment passthrough', async () => {
  // `- VAR` makes Compose print `The "VAR" variable is not set. Defaulting to a
  // blank string.` for every key the operator left as a commented placeholder —
  // CONNECTORS_MCP_PORT once connectors were enabled. That warning reached the
  // ShellUI looking like a failure. Every entry must carry its own default.
  for (const file of ['../../docker-compose.yml', '../../agents.docker-compose.yml']) {
    const compose = YAML.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    for (const [name, service] of Object.entries(compose.services ?? {})) {
      for (const entry of service.environment ?? []) {
        assert.match(String(entry), /=/, `${file} ${name}: "${entry}" must be written as VAR=\${VAR:-default}`);
      }
    }
  }

  const workspace = YAML.parse(await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8'));
  assert.ok(workspace.services.serve.environment.includes('CONNECTORS_MCP_PORT=${CONNECTORS_MCP_PORT:-3338}'));
});

test('required .env keys agree with the compose defaults they mirror', async () => {
  // Three files carry the same values: .env.example (what the operator reads),
  // the compose default (what the container actually receives) and
  // REQUIRED_ENV_KEYS (what a migration writes). A silent divergence is exactly
  // the bug this pins: the documents agent called an endpoint the .env said
  // nothing about.
  const envExample = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
  const composeFiles = await Promise.all(
    ['../../agents.docker-compose.yml', '../../docker-compose.yml']
      .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  const compose = composeFiles.join('\n');

  for (const [key, value] of Object.entries(REQUIRED_ENV_KEYS)) {
    assert.match(
      envExample,
      new RegExp(`^${key}=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      `.env.example must ship ${key} active with the same value`,
    );
    const composeDefault = compose.match(new RegExp(`\\$\\{${key}:-([^}]*)\\}`));
    if (!composeDefault) continue;
    assert.equal(composeDefault[1], value, `${key}: compose default and REQUIRED_ENV_KEYS disagree`);
  }
});

test('no compose default points a deployment at an LLM provider it did not choose', async () => {
  // A hardcoded `${DOCUMENT_LLM_BASE_URL:-https://…}` sent every install to a
  // third-party endpoint the operator never saw, since the key ships commented.
  // The .env is the only source; an empty value also neutralises the image's
  // own ENV fallback.
  const agents = await readFile(new URL('../../agents.docker-compose.yml', import.meta.url), 'utf8');
  const envExample = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');

  for (const key of ['DOCUMENT_LLM_BASE_URL', 'DOCUMENT_LLM_MODEL', 'DOCUMENT_LLM_API_KEY']) {
    assert.match(agents, new RegExp(`- ${key}=\\$\\{${key}:-\\}`), `${key} must have an empty compose default`);
    assert.doesNotMatch(envExample, new RegExp(`^${key}=.+$`, 'm'), `${key} must stay commented in .env.example`);
  }
});

test('log reading resolves service aliases like start and stop do', async () => {
  // `/logs all` used to reach Docker verbatim and fail with `no such service:
  // all` — while `all` is exactly what /help and the completion list suggest.
  const source = await readFile(new URL('./compose.js', import.meta.url), 'utf8');
  const logs = source.slice(source.indexOf('export async function serviceLogs'));
  assert.match(logs, /const aliases = serviceAliases\(\);/);
  assert.match(logs, /const targets = aliases\[service\] \?\? \[service\];/);
  assert.match(logs, /\['logs', '--tail', tail, \.\.\.targets\]/);
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
  // OCR endpoint, model and key carry no default — see the dedicated test.
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
