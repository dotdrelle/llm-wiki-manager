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

test('workspace production agent enables restore by default', async () => {
  const raw = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  const compose = YAML.parse(raw);
  const allowed = compose.services['production-mcp'].environment
    .find((entry) => String(entry).startsWith('PRODUCTION_ALLOWED_STEPS='));
  assert.match(String(allowed), /(?:^|,)restore(?:,|})/);
});

test('shipped compose files never carry a build context', async () => {
  // Ces deux fichiers partent dans le paquet npm, où les dépôts frères
  // (`../agent-external/…`) n'existent pas : un `build:` y rend toute commande
  // Compose irrésolvable chez l'utilisateur. Les images sont construites et
  // publiées par build-and-push.sh, jamais par le manager.
  for (const file of ['../../docker-compose.yml', '../../agents.docker-compose.yml']) {
    const compose = YAML.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    for (const [name, service] of Object.entries(compose.services ?? {})) {
      assert.equal(service.build, undefined, `${file} ${name}: shipped files must reference an image, never build it`);
      assert.ok(service.image, `${file} ${name}: must declare an image`);
    }
  }
});

test('no compose service relies on a bare environment passthrough', async () => {
  // `- VAR` makes Compose print `The "VAR" variable is not set. Defaulting to a
  // blank string.` for every key the operator left as a commented placeholder —
  // CONNECTORS_MCP_PORT once connectors were enabled. That warning reached the
  // ShellUI looking like a failure. Every entry must carry its own default.
  //
  // Une valeur vide est ici sans danger : l'application OAuth embarquée dans
  // l'image du connecteur est lue depuis un fichier, plus depuis un ENV que la
  // chaîne vide écraserait.
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

// Trois variables DOCUMENT_* pour deux conteneurs, chacun n'en déclarant que
// deux : la question « à quoi ça sert » revient à chaque lecture. Ce test fige
// le partage pour que la doc reste vraie.
test('the document handoff keeps input shared and the rest separate', async () => {
  const workspace = YAML.parse(await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8'));
  const agents = YAML.parse(await readFile(new URL('../../agents.docker-compose.yml', import.meta.url), 'utf8'));
  const envOf = (service) => Object.fromEntries(
    (service.environment ?? []).map((entry) => String(entry).split('=', 2)),
  );

  const serve = envOf(workspace.services.serve);
  const documents = envOf(agents.services.documents);

  // `input` est le point de passage : serve y écrit, l'agent y lit.
  assert.equal(serve.DOCUMENT_INPUT_DIR, '/documents/input');
  assert.equal(documents.DOCUMENT_INPUT_DIR, '/documents/input');
  assert.ok(workspace.services.serve.volumes.some((v) => String(v).endsWith(':/documents/input')));
  assert.ok(agents.services.documents.volumes.some((v) => String(v).endsWith(':/documents/input')));

  // Le manifeste des téléversements n'appartient qu'à serve ; la sortie de
  // conversion n'appartient qu'à l'agent. Déclarer l'un chez l'autre laisserait
  // croire à un partage qui n'existe pas.
  assert.equal(serve.DOCUMENT_UPLOADS_DIR, '/documents/uploads');
  assert.equal(documents.DOCUMENT_UPLOADS_DIR, undefined);
  assert.equal(documents.DOCUMENT_OUTPUT_DIR, '/documents/output');
  assert.equal(serve.DOCUMENT_OUTPUT_DIR, undefined);

  // Le plafond est vérifié des deux côtés, donc déclaré des deux côtés.
  assert.ok(serve.DOCUMENT_MAX_UPLOAD_BYTES);
  assert.ok(documents.DOCUMENT_MAX_UPLOAD_BYTES);
});
