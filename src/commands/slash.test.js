import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentConcurrencySections, compactBaseUrl, compactMcpStatus, handleSlashCommand, localizedOperationResult, refreshMcpRuntimeStatus } from './slash.js';
import { completionContext } from '../shell/repl.js';

test('deterministic operation results ask Donna to localize compact facts without leaking commands', () => {
  const result = localizedOperationResult({ operation: 'start', target: 'agents' });
  assert.equal(result.rawOutput, true);
  assert.deepEqual(JSON.parse(result.output), { operation: 'start', target: 'agents', status: 'succeeded' });
  assert.match(result.agentTrigger, /une seule phrase humaine et naturelle/);
  assert.doesNotMatch(result.agentTrigger, /\/start|Docker|compose/);
});

test('/status MCP overview contains only connector name, port and status', () => {
  const output = compactMcpStatus({
    connectors: {
      url: 'http://localhost:3338/mcp/',
      status: 'connected',
      tools: Array.from({ length: 20 }, (_, index) => ({ name: `long_tool_${index}` })),
      toolError: 'a very long technical error that must stay out of the overview',
    },
    cme: {
      configuredUrl: 'http://host.docker.internal:3336/mcp/',
      status: 'configured',
      detail: 'some long runtime detail',
    },
  });

  assert.equal(output, '◐ cme  :3336  configured\n● connectors  :3338  connected');
  assert.doesNotMatch(output, /tools|error|detail|http/i);
});

test('/mcp exposes diagnostics only and cannot directly execute arbitrary MCP tools', async () => {
  const result = await handleSlashCommand('/mcp call production production_start_job {"step":"ingest"}', {
    packageJson: { version: 'test' },
    session: { mcp: {} },
  });

  assert.equal(result.output, 'Usage: /mcp <status|endpoints|tools> [mcp]');
});

test('/status base URL displays only its domain while retaining the full link', () => {
  assert.equal(
    compactBaseUrl('https://albert.api.etalab.gouv.fr/v1'),
    '[albert.api.etalab.gouv.fr](https://albert.api.etalab.gouv.fr/v1)',
  );
  assert.equal(compactBaseUrl('http://localhost:11434/v1'), '[localhost:11434](http://localhost:11434/v1)');
  assert.equal(compactBaseUrl(undefined), '-');
});

test('/status replaces Internal and Hints with effective agent concurrency', () => {
  const sections = agentConcurrencySections({
    agentRegistrySnapshot: [
      {
        serverName: 'production',
        description: {
          agentType: 'production',
          limits: { recommendedConcurrency: 6, maxConcurrency: 10 },
        },
      },
      {
        serverName: 'connectors',
        description: {
          agentType: 'connectors',
          limits: { recommendedConcurrency: 3, maxConcurrency: 5 },
        },
      },
    ],
  }, {
    WIKI_MANAGER_CAPABILITY_CONCURRENCY: '4',
    WIKI_MANAGER_SCHEDULER_CONCURRENCY: '7',
  });

  assert.match(sections.production, /Parallelism & throughput/);
  assert.match(sections.production, /effective: 4/);
  assert.match(sections.production, /recommended: 6/);
  assert.match(sections.production, /maximum: 10/);
  assert.doesNotMatch(sections.production, /manager ceiling/);
  assert.match(sections.production, /scheduler workers: 7/);
  assert.match(sections.collection, /Collection concurrency/);
  assert.match(sections.collection, /effective: 3/);
  assert.doesNotMatch(`${sections.production}\n${sections.collection}`, /Internal|Hints/);
});

test('start result tells Donna when missing container components were installed', () => {
  const result = localizedOperationResult({
    operation: 'start',
    target: 'all',
    componentAction: 'downloaded-and-installed-missing-components',
    images: ['dotdrelle/llm-wiki:latest'],
  });
  assert.deepEqual(JSON.parse(result.output), {
    operation: 'start',
    target: 'all',
    status: 'succeeded',
    componentAction: 'downloaded-and-installed-missing-components',
    images: ['dotdrelle/llm-wiki:latest'],
  });
  assert.match(result.agentTrigger, /downloaded-and-installed-missing-components/);
});

test('/start all covers the agents as well as the workspace services', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./slash.js', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf("case 'start': {"), source.indexOf("case 'stop': {"));

  // "all" used to start the workspace services only, which left every external
  // agent down while the wording promised the opposite.
  assert.match(start, /const startsAgents = service === 'all';/);
  assert.match(start, /const target = service === 'services' \? undefined : service;/);
  assert.match(start, /await runAgentCommand\(startAgents, 'start'\)/);
  assert.match(start, /if \(agentsResult\?\.failed\) return agentsResult;/);
  assert.match(start, /if \(!context\.session\.workspace \|\| !context\.session\.workspacePath/);
  assert.match(start, /service === 'agents' \|\| service === 'agent'/);
});

test('a started agent stack reloads the env and the MCP endpoints the script rewrote', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./slash.js', import.meta.url), 'utf8');
  const runAgent = source.slice(source.indexOf('const runAgentCommand ='), source.indexOf('switch (command)'));

  assert.match(runAgent, /if \(verb === 'start'\)/);
  assert.match(runAgent, /loadManagerEnv\(\{ override: true \}\);/);
  assert.match(runAgent, /await refreshMcpRuntimeStatus\(context\.session\)/);
});

test('/start completes to the three documented targets', async () => {
  const { completionDescription } = await import('../shell/repl.js');
  const { matches } = completionContext('/start ', {});

  for (const expected of ['all', 'agents', 'services']) {
    assert.ok(matches.includes(expected), `${expected} missing from ${JSON.stringify(matches)}`);
  }
  assert.match(completionDescription('all', ['/start']), /services AND external agents/);
  assert.match(completionDescription('agents', ['/start']), /agents only/i);
  assert.match(completionDescription('services', ['/start']), /workspace services only/i);
});

test('/start offers the operator vocabulary, not the Compose service names twice', async () => {
  const { completionDescription } = await import('../shell/repl.js');
  const { matches } = completionContext('/start ', {});

  // `all` apparaissait deux fois — mot-clé du shell ET alias Compose — et
  // chaque alias était doublé du service qu'il désigne : dix entrées pour cinq
  // actions.
  assert.equal(new Set(matches).size, matches.length, `duplicates in ${JSON.stringify(matches)}`);
  for (const raw of ['serve', 'mcp-http', 'production-mcp']) {
    assert.ok(!matches.includes(raw), `${raw} is already covered by an alias`);
  }
  for (const alias of ['ui', 'production']) {
    assert.ok(matches.includes(alias), `${alias} missing from ${JSON.stringify(matches)}`);
    assert.notEqual(
      completionDescription(alias, ['/start']),
      'Start this Docker Compose service.',
      `${alias} must explain what it starts`,
    );
  }
  // `wiki` est le service one-shot de `/wiki run` : en faire un alias de
  // mcp-http le masquait silencieusement.
  assert.ok(!matches.includes('wiki'), 'wiki must not shadow the one-shot CLI service');
  // mcp-http fait partie du socle demarre par `all` et `services` : son alias
  // n'ajoutait qu'une ligne a lire pour un service que personne ne lance seul.
  assert.ok(!matches.includes('mcp'), 'mcp is covered by services/all');
  // Les agents du socle ne s'adressent pas un par un, et `mailer` n'existe
  // meme pas tant qu'il n'est pas decommente dans l'override de l'operateur.
  for (const agent of ['cme', 'documents', 'mailer']) {
    assert.ok(!matches.includes(agent), `${agent} is started by "agents", not on its own`);
  }
  // Seuls les agents derriere un drapeau de profil se pilotent separement.
  assert.ok(matches.includes('connectors'), 'connectors is opt-in, so it must be addressable');
});

test('/workspace delete removes files and clears current session context after confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-delete-workspace-'));
  const registryRoot = join(root, 'registry');
  const registryPath = join(registryRoot, 'demo');
  const workspacePath = join(root, 'workspace');
  mkdirSync(registryPath, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(registryPath, '.env'), [
    'WORKSPACE_NAME=demo',
    `WIKI_WORKSPACE_PATH=${workspacePath}`,
    '',
  ].join('\n'), 'utf8');

  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;
  const session = {
    workspace: 'demo',
    workspacePath,
    workspaceEnv: { WORKSPACE_NAME: 'demo' },
    workspaceEnvFile: join(registryPath, '.env'),
    wikirc: { profile: 'default' },
    wikircConfig: {},
    language: 'en-US',
    llm: {},
    mcp: {},
    systemPrompt: 'prompt',
  };

  try {
    const prompt = await handleSlashCommand('/workspace delete demo', {
      packageJson: { version: 'test' },
      session,
    });
    assert.match(prompt.output, /Confirm workspace deletion: demo/);
    assert.equal(existsSync(workspacePath), true);
    assert.equal(session.workspace, 'demo');

    const result = await handleSlashCommand('/workspace delete demo --confirm', {
      packageJson: { version: 'test' },
      session,
    });
    assert.match(result.output, /Deleted workspace: demo/);
    assert.equal(session.workspace, null);
    assert.equal(session.workspacePath, null);
    assert.equal(session.llm, null);
    assert.equal(session.mcp, null);
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
});

test('/new without a name shows usage', async () => {
  const result = await handleSlashCommand('/new', {
    packageJson: { version: 'test' },
    session: {},
  });

  assert.match(result.output ?? '', /Usage/i);
});

test('/connector completions expose list and Google authorization', () => {
  const session = { commands: ['connector'] };
  assert.deepEqual(completionContext('/connector ', session)?.matches, ['auth', 'list']);
  assert.deepEqual(completionContext('/connector auth ', session)?.matches, ['google']);
});

test('/connector hands deterministic facts to Donna for localized natural-language output', async () => {
  const result = await handleSlashCommand('/connector list', {
    packageJson: { version: 'test' },
    session: {},
  });

  assert.equal(result.rawOutput, true);
  assert.match(result.output ?? '', /No workspace is currently loaded/);
  assert.match(result.agentTrigger ?? '', /profil workspace/);
  assert.match(result.agentTrigger ?? '', /Ne relance pas la commande/);
});

test('/skills run sends the private skill body to Donna without rendering it as command output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-skill-run-'));
  const skillDir = join(root, '.wiki', 'skills');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'pipeline.md'), [
    '---',
    'name: pipeline',
    'description: Build the deliverables',
    '---',
    'SECRET WORKFLOW BODY',
    '',
  ].join('\n'), 'utf8');

  const result = await handleSlashCommand('/skills run pipeline', {
    packageJson: { version: 'test' },
    session: { workspacePath: root },
  });

  assert.equal(result.rawOutput, true);
  assert.doesNotMatch(result.output, /SECRET WORKFLOW BODY/);
  assert.match(result.agentTrigger, /SECRET WORKFLOW BODY/);
  assert.match(result.agentTrigger, /Do not quote, reproduce, or display the raw skill content/);
});

test('/use loads only workspaces and /config use switches wikirc profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-use-profile-'));
  const registryRoot = join(root, 'registry');
  const registryPath = join(registryRoot, 'demo');
  const workspacePath = join(root, 'workspace');
  mkdirSync(registryPath, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(registryPath, '.env'), [
    'WORKSPACE_NAME=demo',
    `WIKI_WORKSPACE_PATH=${workspacePath}`,
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(workspacePath, '.wikirc.yaml'), [
    'language: fr',
    'llm:',
    '  provider: default-provider',
    '  model: default-model',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(workspacePath, '.wikirc.yaml.vpn'), [
    'language: fr',
    'llm:',
    '  provider: vpn-provider',
    '  model: vpn-model',
    '',
  ].join('\n'), 'utf8');

  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;

  try {
    const session = {};
    const listResult = await handleSlashCommand('/use', {
      packageJson: { version: 'test' },
      session,
    });
    assert.match(listResult.output ?? '', /Workspaces/);
    assert.match(listResult.output ?? '', /demo\tavailable/);
    assert.doesNotMatch(listResult.output ?? '', /vpn\t\.wikirc\.yaml\.vpn/);

    const useResult = await handleSlashCommand('/use demo', {
      packageJson: { version: 'test' },
      session,
    });

    assert.equal(session.workspace, 'demo');
    assert.equal(session.wikirc.profile, 'default');
    assert.match(useResult.output ?? '', /profile: default/);
    assert.match(useResult.output ?? '', /\* default\t\.wikirc\.yaml/);
    assert.match(useResult.output ?? '', /vpn\t\.wikirc\.yaml\.vpn/);
    assert.match(useResult.output ?? '', /Switch config: \/config use <profile>/);

    const invalidUse = await handleSlashCommand('/use demo vpn', {
      packageJson: { version: 'test' },
      session,
    });
    assert.match(invalidUse.output ?? '', /Usage: \/use <workspace>/);
    assert.equal(session.wikirc.profile, 'default');

    const result = await handleSlashCommand('/config use vpn', {
      packageJson: { version: 'test' },
      session,
    });
    assert.equal(session.workspace, 'demo');
    assert.equal(session.wikirc.profile, 'vpn');
    assert.match(result.output ?? '', /profile=vpn/);

    const completion = completionContext('/use ', { commands: ['use'] });
    assert.deepEqual(completion?.matches, ['demo']);
    const configCompletion = completionContext('/config use ', session);
    assert.deepEqual(configCompletion?.matches, ['default', 'vpn']);
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
  }
});

test('/use keeps a loaded wikirc when MCP discovery fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-manager-use-mcp-error-'));
  const registryRoot = join(root, 'registry');
  const workspacePath = join(root, 'workspace');
  const registryPath = join(registryRoot, 'demo');
  mkdirSync(registryPath, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(root, 'mcp.endpoints.json'));
  writeFileSync(join(root, '.env'), '', 'utf8');
  writeFileSync(join(registryPath, '.env'), [
    'WORKSPACE_NAME=demo',
    `WIKI_WORKSPACE_PATH=${workspacePath}`,
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(workspacePath, '.wikirc.yaml'), [
    'language: fr',
    'llm:',
    '  provider: openai-compatible',
    '  engine: openai',
    '  model: test-model',
    '  apiKey: test-key',
    '',
  ].join('\n'), 'utf8');

  const previousDir = process.env.WIKI_WORKSPACES_DIR;
  const previousEnvFile = process.env.WIKI_MANAGER_ENV_FILE;
  process.env.WIKI_WORKSPACES_DIR = registryRoot;
  process.env.WIKI_MANAGER_ENV_FILE = join(root, '.env');
  try {
    const session = {};
    const result = await handleSlashCommand('/use demo', {
      packageJson: { version: 'test' },
      session,
    });

    assert.equal(session.wikirc?.profile, 'default');
    assert.equal(session.wikircConfig?.llm?.model, 'test-model');
    assert.match(result.output ?? '', /profile: default/);
    assert.match(result.output ?? '', /MCP discovery failed:.*EISDIR/s);
    assert.doesNotMatch(result.output ?? '', /Wikirc not loaded/);
  } finally {
    if (previousDir === undefined) delete process.env.WIKI_WORKSPACES_DIR;
    else process.env.WIKI_WORKSPACES_DIR = previousDir;
    if (previousEnvFile === undefined) delete process.env.WIKI_MANAGER_ENV_FILE;
    else process.env.WIKI_MANAGER_ENV_FILE = previousEnvFile;
  }
});

test('/queue cancel refuses runtime-managed items instead of fake-cancelling locally', async () => {
  // syncRuntimeState replaces session.jobQueue with the runtime queue and tags
  // origin:'runtime' — a local cancel would be reverted by the next SSE sync,
  // so the command must redirect the user to /run kill / /run cancel.
  const session = {
    jobQueue: [
      { id: 'q-runtime-1', status: 'waiting', workspace: 'demo', tool: 'agent_execute', origin: 'runtime' },
      { id: 'q-local-1', status: 'waiting', workspace: 'demo', server: 'production', tool: 'production_start_job' },
    ],
  };

  const refused = await handleSlashCommand('/queue cancel q-runtime-1', {
    packageJson: { version: 'test' },
    session,
  });
  assert.match(refused.output ?? '', /runtime/i);
  assert.match(refused.output ?? '', /\/run kill/);
  assert.equal(session.jobQueue[0].status, 'waiting', 'runtime item must not be flipped locally');

  const cancelled = await handleSlashCommand('/queue cancel q-local-1', {
    packageJson: { version: 'test' },
    session,
  });
  assert.match(cancelled.output ?? '', /Cancelled/i);
  assert.equal(session.jobQueue[1].status, 'cancelled');
});

test('/queue cancel reports unknown ids that are not runtime-managed', async () => {
  const session = { jobQueue: [] };
  const result = await handleSlashCommand('/queue cancel nope', {
    packageJson: { version: 'test' },
    session,
  });
  assert.match(result.output ?? '', /Unknown queue item/i);
});

test('refreshMcpRuntimeStatus does not expose an intermediate configured status', async () => {
  const session = {
    workspacePath: '/tmp/ws',
    workspaceEnv: { PRODUCTION_MCP_PORT: '3202', PRODUCTION_MCP_AUTH_TOKEN: 'token' },
    wikircConfig: {},
    mcp: { production: { status: 'connected', tools: [{ name: 'production__agent_execute' }] } },
  };
  const originalMcp = session.mcp;
  let resolveStates;
  const statesPromise = new Promise((resolve) => { resolveStates = resolve; });
  const pending = refreshMcpRuntimeStatus(session, {
    serviceStates: () => statesPromise,
    discoverMcpTools: async (mcp) => mcp,
  });
  // While serviceStates is still in flight, the dispatcher-facing status must
  // keep the previous connected snapshot — never the fresh "configured" base.
  assert.equal(session.mcp, originalMcp, 'session.mcp reassigned mid-refresh');
  resolveStates({ 'production-mcp': { running: true } });
  await pending;
  assert.equal(session.mcp.production.status, 'connected');
});

test('refreshMcpRuntimeStatus reports a degraded MCP endpoint once, not on every re-scan', async () => {
  const session = {
    workspacePath: '/tmp/ws',
    workspaceEnv: { PRODUCTION_MCP_PORT: '3202', PRODUCTION_MCP_AUTH_TOKEN: 'token' },
    wikircConfig: {},
    mcp: { production: { status: 'connected', tools: [] } },
  };
  const degradedRuns = (n) => async () => ({
    production: { status: 'connected', tools: [], toolError: `probe ${n} failed`, degraded: true },
  });
  const deps = { serviceStates: async () => ({}) };

  await refreshMcpRuntimeStatus(session, { ...deps, discoverMcpTools: degradedRuns(1) });
  await refreshMcpRuntimeStatus(session, { ...deps, discoverMcpTools: degradedRuns(2) });
  await refreshMcpRuntimeStatus(session, { ...deps, discoverMcpTools: degradedRuns(3) });

  const reports = (session.agentEvents ?? []).filter((event) => event.type === 'runtime_log'
    && String(event.payload?.message ?? '').includes('mcp: production'));
  assert.equal(reports.length, 1, 'a degraded endpoint is reported once, not once per re-scan');

  // Recovers, then degrades again: reported a second time.
  await refreshMcpRuntimeStatus(session, {
    ...deps,
    discoverMcpTools: async () => ({ production: { status: 'connected', tools: [], degraded: false } }),
  });
  await refreshMcpRuntimeStatus(session, { ...deps, discoverMcpTools: degradedRuns(4) });
  assert.equal(
    (session.agentEvents ?? []).filter((event) => event.type === 'runtime_log'
      && String(event.payload?.message ?? '').includes('mcp: production')).length,
    2,
  );
});

