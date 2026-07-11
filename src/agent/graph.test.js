import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentSystemPrompt, createAgentGraph, invalidSuggestedSlashCommands, invalidUserFacingToolNames, knownCapabilityIds, normalizeToolArgumentsFromSchema } from './graph.js';

test('user-facing response guard hides MCP identifiers generically', () => {
  const session = sessionBase();
  assert.deepEqual(
    invalidUserFacingToolNames('Utilisez production__production_start_job.', session),
    ['production__production_start_job'],
  );
});

test('Donna cannot answer an explicit action with manual instructions instead of delegating', async () => {
  const originalFetch = globalThis.fetch;
  let delegated = false;
  globalThis.fetch = async (url) => {
    delegated = String(url).includes('/delegate');
    return { ok: true, status: 202, json: async () => ({ accepted: true, runId: 'run-action', delegation: { tasks: 2, agent: 'production' } }) };
  };
  let mainCalls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    llm: {
      async completeWithTools({ tools }) {
        if (tools.length === 0) return { content: '{"action":true}', message: { role: 'assistant', content: '{"action":true}' }, tool_calls: null };
        mainCalls += 1;
        if (mainCalls === 1) {
          return {
            content: 'Déplacez raw/untracked/demo.md vers raw/ puis utilisez wiki__wiki_workspace_status.',
            message: { role: 'assistant', content: 'instructions manuelles' },
            tool_calls: null,
          };
        }
        if (mainCalls === 2) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{ id: 'delegate', type: 'function', function: { name: 'runtime__delegate', arguments: '{"objective":"Lance ingestion"}' } }],
          };
        }
        return { content: 'Plan soumis.', message: { role: 'assistant', content: 'Plan soumis.' }, tool_calls: null };
      },
    },
  });

  try {
    const result = await createAgentGraph().invoke({ input: 'lance ingestion', session });
    assert.equal(delegated, true);
    assert.equal(result.response, 'Plan soumis.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function sessionBase(overrides = {}) {
  return {
    commands: ['status'],
    workspace: 'docs',
    workspaceEnv: {},
    mcp: {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        tools: [{
          name: 'production_start_job',
          description: 'Start production job',
          inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
        }],
      },
    },
    ...overrides,
  };
}

function toolCallingLlm() {
  let calls = 0;
  return {
    async completeWithTools() {
      calls += 1;
      if (calls === 1) {
        return {
          content: null,
          message: { role: 'assistant', content: null },
          tool_calls: [
            {
              id: 'plan-call',
              type: 'function',
              function: {
                name: 'wiki__plan_set',
                arguments: '{"steps":["Run production job"]}',
              },
            },
            {
              id: 'tool-call',
              type: 'function',
              function: {
                name: 'production__production_start_job',
                arguments: '{"type":"doctor"}',
              },
            },
          ],
        };
      }
      return {
        content: 'Done.',
        message: { role: 'assistant', content: 'Done.' },
        tool_calls: null,
      };
    },
  };
}

test('agent graph waits for run-level approval before first MCP action', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
    };
  };
  const approvals = [];
  const session = sessionBase({
    _runApprovalRequired: true,
    _currentRunIdentity: { runId: 'run-approval', turnId: 'run-approval:turn-1', workspace: 'docs' },
    _requestApproval: async (request) => {
      approvals.push(request);
      assert.equal(fetchCalls, 0);
      return { approved: true };
    },
    llm: toolCallingLlm(),
  });

  try {
    const agent = createAgentGraph();
    const result = await agent.invoke({ input: 'Run doctor', session });

    assert.equal(result.response, 'Done.');
    assert.equal(fetchCalls, 1);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].scope, 'run');
    assert.deepEqual(approvals[0].plan, ['Run production job']);
    assert.equal(session._runApprovalResolved, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent graph reports LLM unavailable without Donna active boilerplate', async () => {
  const agent = createAgentGraph();
  const result = await agent.invoke({ input: 'salut', session: sessionBase({ llm: null }) });

  assert.equal(result.response, '⚠ LLM injoignable : aucun client LLM configure');
  assert.doesNotMatch(result.response, /Donna is active/);
});

test('agent graph binds the full toolset and lets Donna decide whether to call tools', async () => {
  const seenTools = [];
  const session = sessionBase({
    llm: {
      async completeWithTools({ tools }) {
        seenTools.push(...tools.map((tool) => tool.function.name));
        return {
          content: 'Salut, je suis là.',
          message: { role: 'assistant', content: 'Salut, je suis là.' },
          tool_calls: null,
        };
      },
    },
  });

  const agent = createAgentGraph();
  const result = await agent.invoke({ input: 'salut', session });

  assert.equal(result.response, 'Salut, je suis là.');
  assert.ok(seenTools.length > 0);
  assert.ok(seenTools.includes('shell__read_command'));
  assert.ok(seenTools.includes('shell__run_command'));
  assert.ok(seenTools.includes('shell__profile_update'));
  assert.ok(seenTools.includes('wiki__plan_set'));
  assert.ok(seenTools.includes('wiki__plan_done'));
  assert.equal(session.headlessPlan ?? null, null);
  assert.equal(Object.keys(session.activities ?? {}).length, 0);
});

test('agent graph does not pre-filter mutating MCP tools for config questions', async () => {
  const seenTools = [];
  const session = sessionBase({
    mcp: {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        tools: [
          {
            name: 'production_start_job',
            description: 'Start production job',
            inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
          },
          {
            name: 'production_job_status',
            description: 'Read production job status',
            inputSchema: { type: 'object', properties: { jobId: { type: 'string' } } },
          },
        ],
      },
    },
    llm: {
      async completeWithTools({ tools }) {
        seenTools.push(...tools.map((tool) => tool.function.name));
        return {
          content: 'Le profil actif est docs.',
          message: { role: 'assistant', content: 'Le profil actif est docs.' },
          tool_calls: null,
        };
      },
    },
  });

  const agent = createAgentGraph();
  const result = await agent.invoke({ input: 'quel est le profil actif ?', session });

  assert.equal(result.response, 'Le profil actif est docs.');
  assert.ok(seenTools.includes('shell__read_command'));
  assert.ok(seenTools.includes('production__production_job_status'));
  assert.ok(seenTools.includes('wiki__plan_set'));
  assert.ok(seenTools.includes('production__production_start_job'));
  assert.ok(seenTools.includes('shell__run_command'));
});

test('interactive Donna delegates provider execution to the runtime orchestrator', async () => {
  const seenTools = [];
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    agentRegistrySnapshot: ingestAgentSnapshot(),
    mcp: {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        tools: [
          { name: 'agent_plan', description: 'Plan tasks', inputSchema: { type: 'object', properties: {} } },
          { name: 'agent_execute', description: 'Execute a task', inputSchema: { type: 'object', properties: {} } },
          { name: 'agent_status', description: 'Read task status', inputSchema: { type: 'object', properties: {} } },
          { name: 'production_start_job', description: 'Legacy job start', inputSchema: { type: 'object', properties: {} } },
          { name: 'production_status', description: 'Read production status', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    },
    llm: {
      async completeWithTools({ tools }) {
        seenTools.push(...tools.map((tool) => tool.function.name));
        return { content: 'Prêt.', message: { role: 'assistant', content: 'Prêt.' }, tool_calls: null };
      },
    },
  });

  await createAgentGraph().invoke({ input: 'bonjour', session });

  assert.ok(seenTools.includes('runtime__delegate'));
  assert.ok(seenTools.includes('production__agent_status'));
  assert.ok(seenTools.includes('production__production_status'));
  assert.ok(!seenTools.includes('production__agent_plan'));
  assert.ok(!seenTools.includes('production__agent_execute'));
  assert.ok(!seenTools.includes('production__production_start_job'));
  assert.ok(!seenTools.includes('wiki__plan_set'));
  assert.ok(!seenTools.includes('wiki__plan_done'));
});

test('interactive Donna can delegate while the shell capability snapshot is still empty', async () => {
  const seenTools = [];
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    agentRegistrySnapshot: [],
    llm: {
      async completeWithTools({ tools }) {
        seenTools.push(...tools.map((tool) => tool.function.name));
        return { content: 'Prêt.', message: { role: 'assistant', content: 'Prêt.' }, tool_calls: null };
      },
    },
  });

  await createAgentGraph().invoke({ input: 'bonjour', session });

  assert.ok(seenTools.includes('runtime__delegate'));
});

function ingestAgentSnapshot() {
  return [{
    agentInstanceId: 'production-ingest',
    serverName: 'production',
    health: 'available',
    description: {
      contractVersion: '1',
      agentType: 'production',
      displayName: 'Production',
      capabilities: [{
        id: 'knowledge.update',
        version: '1',
        supportedOperations: ['ingest', 'ingest_plan', 'ingest_apply'],
      }],
    },
  }];
}

test('runtime delegation tool declares only its canonical natural-language objective', async () => {
  let delegationTool = null;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    agentRegistrySnapshot: ingestAgentSnapshot(),
    llm: {
      async completeWithTools({ tools }) {
        delegationTool ??= tools.find((tool) => tool.function.name === 'runtime__delegate');
        return { content: 'Prêt.', message: { role: 'assistant', content: 'Prêt.' }, tool_calls: null };
      },
    },
  });

  await createAgentGraph().invoke({ input: 'bonjour', session });

  assert.deepEqual(Object.keys(delegationTool.function.parameters.properties), ['objective']);
  assert.deepEqual(delegationTool.function.parameters.required, ['objective']);
});

test('tool argument normalization repairs only an unambiguous schema-compatible field name', () => {
  const schema = {
    type: 'object',
    properties: { objective: { type: 'string' } },
    required: ['objective'],
    additionalProperties: false,
  };
  assert.deepEqual(
    normalizeToolArgumentsFromSchema({ input: 'Ingérer les fichiers' }, schema),
    { objective: 'Ingérer les fichiers' },
  );
  assert.deepEqual(
    normalizeToolArgumentsFromSchema({ input: 'x', other: 'y' }, schema),
    { input: 'x', other: 'y' },
  );
  assert.deepEqual(
    normalizeToolArgumentsFromSchema({ input: 42 }, schema),
    { input: 42 },
  );
});

test('Donna delegates the objective without choosing technical identifiers', async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, status: 202, json: async () => ({ accepted: true, runId: 'run-1', delegation: { tasks: 5, agent: 'production' } }) };
  };
  let calls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    agentRegistrySnapshot: ingestAgentSnapshot(),
    llm: {
      async completeWithTools({ messages }) {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'delegate',
              type: 'function',
              function: { name: 'runtime__delegate', arguments: '{"input":"Ingérer tous les fichiers en attente"}' },
            }],
          };
        }
        return { content: 'Plan validé.', message: { role: 'assistant', content: 'Plan validé.' }, tool_calls: null };
      },
    },
  });

  try {
    await createAgentGraph().invoke({ input: 'ingère tout', session });
    assert.match(request.url, /\/delegate/);
    assert.deepEqual(request.body, { objective: 'Ingérer tous les fichiers en attente', workspace: 'docs' });
    assert.equal('capability' in request.body, false);
    assert.equal('operation' in request.body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime status does not manufacture a plan', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'idle', running: false, plan: [], queue: [], controlQueue: [], approvals: [] }),
  });
  let calls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    llm: {
      async completeWithTools() {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{ id: 'status', type: 'function', function: { name: 'runtime__status', arguments: '{}' } }],
          };
        }
        return { content: 'Aucun run actif.', message: { role: 'assistant', content: 'Aucun run actif.' }, tool_calls: null };
      },
    },
  });

  try {
    const result = await createAgentGraph().invoke({ input: 'où en est le travail ?', session });
    assert.equal(result.response, 'Aucun run actif.');
    assert.equal(session.headlessPlan ?? null, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one Donna approval grants the complete validated run revision', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
    if ((options.method ?? 'GET') === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          running: true,
          runId: 'run-approval',
          planRevision: 3,
          approvals: [
            { status: 'pending_approval', approvalClasses: ['workspace'] },
            { status: 'pending_approval', approvalClasses: ['workspace'] },
          ],
        }),
      };
    }
    return { ok: true, status: 202, json: async () => ({ approved: true, runId: 'run-approval' }) };
  };
  let calls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    agentProjection: { status: 'running', conversation: [], activities: [] },
    llm: {
      async completeWithTools() {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'approve-run',
              type: 'function',
              function: { name: 'runtime__approve', arguments: '{}' },
            }],
          };
        }
        return { content: 'Plan approuvé.', message: { role: 'assistant', content: 'Plan approuvé.' }, tool_calls: null };
      },
    },
  });

  try {
    const result = await createAgentGraph().invoke({ input: 'oui', session });
    assert.equal(result.response, 'Plan approuvé.');
    const approval = requests.find((request) => request.url.includes('/approve'));
    assert.deepEqual(approval.body, {
      workspace: 'docs',
      runId: 'run-approval',
      itemId: null,
      approvalId: null,
      scope: 'run',
      planRevision: 3,
      approvalClasses: ['workspace'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent graph binds the full toolset for a "remember my preference" request, not just read-only tools', async () => {
  const seenTools = [];
  const session = sessionBase({
    mcp: {
      wiki: {
        status: 'connected',
        url: 'http://127.0.0.1:3001/mcp/',
        tools: [
          {
            name: 'profile_read',
            description: 'Read the workspace profile from .wiki/profile.md.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'profile_update',
            description: 'Write the workspace profile to .wiki/profile.md.',
            inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
          },
        ],
      },
    },
    llm: {
      async completeWithTools({ tools }) {
        seenTools.push(...tools.map((tool) => tool.function.name));
        return {
          content: 'Noté, je retiens cette préférence.',
          message: { role: 'assistant', content: 'Noté, je retiens cette préférence.' },
          tool_calls: null,
        };
      },
    },
  });

  const agent = createAgentGraph();
  const result = await agent.invoke({ input: 'retiens que je préfère des réponses courtes', session });

  assert.equal(result.response, 'Noté, je retiens cette préférence.');
  // profile_update is a write tool (doesn't match the read-only name pattern)
  // and "retiens" doesn't appear in the config/status read-only phrasing —
  // without action-intent coverage for remember/save/update requests, this
  // tool would silently never be offered to the LLM at all.
  assert.ok(seenTools.includes('wiki__profile_update'));
  assert.ok(seenTools.includes('wiki__profile_read'));
  assert.ok(seenTools.includes('shell__profile_update'));
});

test('buildAgentSystemPrompt includes .wiki/profile.md content so preferences apply without a tool call', () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'donna-profile-'));
  mkdirSync(join(workspacePath, '.wiki'), { recursive: true });
  writeFileSync(
    join(workspacePath, '.wiki', 'profile.md'),
    '# Workspace Profile\n\n## User Preferences\n\n- Tutoiement : me tutoyer\n',
  );
  try {
    const prompt = buildAgentSystemPrompt({
      session: sessionBase({ workspacePath }),
    });
    assert.match(prompt, /Tutoiement : me tutoyer/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('buildAgentSystemPrompt omits the profile section when profile.md is missing or empty', () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'donna-profile-empty-'));
  try {
    const prompt = buildAgentSystemPrompt({ session: sessionBase({ workspacePath }) });
    assert.doesNotMatch(prompt, /Workspace profile \(\.wiki\/profile\.md\)/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('agent graph waits for tool-level approval configured on endpoint', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
  });
  const approvals = [];
  const session = sessionBase({
    mcp: {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        requireApproval: ['production_start_job'],
        tools: [{
          name: 'production_start_job',
          description: 'Start production job',
          inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
        }],
      },
    },
    _currentRunIdentity: { runId: 'run-tool-approval', turnId: 'run-tool-approval:turn-1', workspace: 'docs' },
    _requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
    llm: toolCallingLlm(),
  });

  try {
    const agent = createAgentGraph();
    await agent.invoke({ input: 'Run doctor', session });

    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].scope, 'tool');
    assert.equal(approvals[0].tool, 'production.production_start_job');
    assert.equal(session.jobQueue[0].status, 'approved');
    assert.equal(session.jobQueue[0].reason, 'approval_required');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent graph accepts structured wiki plan steps without selecting MCP executors implicitly', async () => {
  let calls = 0;
  const session = sessionBase({
    mcp: {
      cme: {
        status: 'connected',
        url: 'http://127.0.0.1:3001/mcp/',
        tools: [{
          name: 'cme_export_run',
          description: 'Export CME pages',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        tools: [{
          name: 'production_start_job',
          description: 'Start production job',
          inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
        }],
      },
    },
    llm: {
      async completeWithTools() {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'plan-call',
              type: 'function',
              function: {
                name: 'wiki__plan_set',
                arguments: JSON.stringify({
                  steps: [
                    {
                      id: 'cme-export',
                      description: 'Export CME pages',
                      requiredCapability: 'external-source.export',
                      executor: 'cme.cme_export_run',
                      executorQuery: { capability: 'legacy export' },
                      outputRefs: ['raw/untracked'],
                    },
                    {
                      id: 'build',
                      description: 'Run production build',
                      requiredCapability: 'knowledge.pipeline',
                      dependsOn: ['cme-export'],
                    },
                  ],
                }),
              },
            }],
          };
        }
        return {
          content: 'Plan ready.',
          message: { role: 'assistant', content: 'Plan ready.' },
          tool_calls: null,
        };
      },
    },
  });

  const agent = createAgentGraph();
  const result = await agent.invoke({ input: 'Plan export then build', session });

  assert.equal(result.response, 'Plan ready.');
  assert.deepEqual(session.headlessPlan.map((step) => step.id), ['cme-export', 'build']);
  assert.deepEqual(session.headlessPlan.map((step) => step.requiredCapability), ['external-source.export', 'knowledge.pipeline']);
  assert.equal(session.headlessPlan[0].executor, null);
  assert.equal(session.headlessPlan[0].executorQuery, null);
  assert.equal(session.headlessPlan[1].executor, null);
  assert.deepEqual(session.headlessPlan[1].dependsOn, ['cme-export']);
  assert.deepEqual(session.headlessPlan[0].outputRefs, ['raw/untracked']);
});

test('buildAgentSystemPrompt forbids inventing slash commands or arguments', () => {
  const prompt = buildAgentSystemPrompt({ session: sessionBase({ commands: ['status', 'services'] }) });
  assert.match(prompt, /Available primitives: \/status, \/services\./);
  assert.match(prompt, /Do not invent command names, subcommands, or arguments/);
  assert.doesNotMatch(prompt, /\/restart serve/);
  assert.doesNotMatch(prompt, /executorQuery/);
  assert.doesNotMatch(prompt, /executor:"/);
});

test('workspace package manifest is not exposed as an executable skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-manager-skills-'));
  try {
    mkdirSync(join(root, '.wiki', 'skills'), { recursive: true });
    writeFileSync(join(root, 'skill.yaml'), [
      'name: basic',
      'description: Demo workspace package',
      'entrypoints:',
      '  uiSkillDir: .wiki/skills',
    ].join('\n'));
    writeFileSync(join(root, '.wiki', 'skills', 'ingest.md'), [
      '---',
      'name: ingest',
      'description: Ingest pending sources',
      '---',
      'Use the production capability.',
    ].join('\n'));

    const prompt = buildAgentSystemPrompt({ session: sessionBase({ workspacePath: root }) });
    assert.doesNotMatch(prompt, /\/basic:/);
    assert.match(prompt, /\/ingest: Ingest pending sources/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('system prompt forbids unsolicited next-step sections', () => {
  const prompt = buildAgentSystemPrompt({ session: sessionBase() });
  assert.match(prompt, /Never add a "Next steps", "Prochaines étapes", "À suivre"/);
  assert.match(prompt, /unless the user explicitly asks what to do next/);
  assert.doesNotMatch(prompt, /list the suggested follow-ups/);
});

test('system prompt requests synthetic responses capped at about twenty lines without internal narration', () => {
  const prompt = buildAgentSystemPrompt({ session: sessionBase() });
  assert.match(prompt, /never exceed roughly 15 to 20 short lines/);
  assert.match(prompt, /Prioritize the result, essential facts, concrete errors, and actual outputs/);
  assert.match(prompt, /Never expose internal reasoning, repeated checks, tool-selection commentary, or a chronological diary/);
});

test('slash-command output guard rejects commands outside the real agent command set', () => {
  const session = sessionBase({ commands: ['status', 'wiki', 'openui'] });
  assert.deepEqual(
    invalidSuggestedSlashCommands('Vérifiez avec :\n```bash\n/wiki list_pages\n```', session),
    ['wiki'],
  );
  assert.deepEqual(invalidSuggestedSlashCommands('Le résultat est disponible dans `/openui`.', session), []);
});

test('Donna retries instead of displaying an invented slash command', async () => {
  let calls = 0;
  const session = sessionBase({
    commands: ['status', 'openui'],
    llm: {
      async completeWithTools() {
        calls += 1;
        if (calls === 1) {
          const content = 'Vérifiez ensuite avec :\n```bash\n/wiki list_pages\n```';
          return { content, message: { role: 'assistant', content }, tool_calls: null };
        }
        const content = 'Ingestion terminée. Le résultat est disponible dans `/openui`.';
        return { content, message: { role: 'assistant', content }, tool_calls: null };
      },
    },
  });

  const result = await createAgentGraph().invoke({ input: 'résume le résultat', session });
  assert.equal(calls, 2);
  assert.equal(result.response, 'Ingestion terminée. Le résultat est disponible dans `/openui`.');
  assert.doesNotMatch(result.response, /wiki list_pages/);
});

test('Donna retries a malformed tool call without reinjecting its broken JSON', async () => {
  let calls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    llm: {
      async completeWithTools({ messages }) {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'broken',
              type: 'function',
              function: { name: 'runtime__delegate', arguments: '{"objective":"Ingère' },
            }],
          };
        }
        assert.doesNotMatch(JSON.stringify(messages), /arguments.*Ingère/);
        return { content: 'Appel reformulé.', message: { role: 'assistant', content: 'Appel reformulé.' }, tool_calls: null };
      },
    },
  });

  await createAgentGraph().invoke({ input: 'ingère les fichiers', session });
  assert.equal(calls, 2);
});

test('forced delegation is cleared after one valid tool call and does not loop', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 202,
    json: async () => ({ accepted: true, runId: 'run-once' }),
  });
  const choices = [];
  let calls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    commands: ['status'],
    llm: {
      async completeWithTools({ toolChoice, tools }) {
        if (tools.length === 0) {
          return { content: '{"action":true}', message: { role: 'assistant', content: '{"action":true}' }, tool_calls: null };
        }
        calls += 1;
        choices.push(toolChoice);
        if (calls === 1) {
          const content = 'Utilise cette commande :\n/pipeline';
          return { content, message: { role: 'assistant', content }, tool_calls: null };
        }
        if (calls === 2) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'delegate-once',
              type: 'function',
              function: { name: 'runtime__delegate', arguments: '{"objective":"Ingérer les fichiers"}' },
            }],
          };
        }
        return { content: 'Ingestion déléguée.', message: { role: 'assistant', content: 'Ingestion déléguée.' }, tool_calls: null };
      },
    },
  });

  try {
    const result = await createAgentGraph().invoke({ input: 'lance ingestion', session });
    assert.equal(calls, 3);
    assert.deepEqual(choices[1], { type: 'function', function: { name: 'runtime__delegate' } });
    assert.equal(choices[2], 'auto');
    assert.equal(result.response, 'Ingestion déléguée.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Guard: the system prompt must never show a connected tool's bare name
// outside its qualified server__tool form. Bare mentions are what teach the
// model to emit unqualified tool calls (the cme_status incident). The bare
// name list comes from the session's declared servers, never from a manual
// list (amendment A6). New prompt text or injected skill descriptions that
// reintroduce a bare name must fail here.
test('buildAgentSystemPrompt contains no unqualified tool names for connected servers', () => {
  const session = sessionBase({
    mcp: {
      production: {
        status: 'connected',
        tools: [
          { name: 'production_start_job' }, { name: 'production_job_status' },
          { name: 'production_job_logs' }, { name: 'production_cancel_job' },
          { name: 'production_list_jobs' }, { name: 'production_list_templates' },
          { name: 'production_status' }, { name: 'agent_describe' },
          { name: 'agent_plan' }, { name: 'agent_execute' },
          { name: 'agent_status' }, { name: 'agent_cancel' },
        ],
      },
      cme: {
        status: 'connected',
        tools: [
          { name: 'cme_status' }, { name: 'cme_setup' },
          { name: 'cme_sources_list' }, { name: 'cme_source_add' },
          { name: 'cme_source_remove' }, { name: 'cme_export_run' },
          { name: 'cme_export_status' }, { name: 'cme_export_cancel' },
          { name: 'agent_describe' }, { name: 'agent_execute' },
          { name: 'agent_status' }, { name: 'agent_cancel' },
        ],
      },
    },
  });
  const prompt = buildAgentSystemPrompt({ session });
  const offenders = [];
  for (const [serverName, value] of Object.entries(session.mcp)) {
    for (const tool of value.tools) {
      // A bare occurrence is the tool name not embedded in a wider
      // identifier: `production__production_start_job` does not match
      // because the inner occurrence is preceded by `_`.
      const bare = new RegExp(`(?<![\\w])${tool.name}(?![\\w])`);
      if (bare.test(prompt)) offenders.push(`${serverName}:${tool.name}`);
    }
  }
  assert.deepEqual(offenders, [], `Unqualified tool names found in system prompt: ${offenders.join(', ')}`);
});

function orchestrableAgentSnapshot() {
  return [{
    agentInstanceId: 'production-1',
    serverName: 'production',
    health: 'available',
    description: {
      contractVersion: '1',
      agentType: 'production',
      displayName: 'Production agent',
      capabilities: [
        { id: 'knowledge.pipeline', version: '1' },
        { id: 'external-source.export', version: '1' },
      ],
    },
  }];
}

test('knownCapabilityIds reflects the discovered registry snapshot', () => {
  const session = sessionBase({ agentRegistrySnapshot: orchestrableAgentSnapshot() });
  assert.deepEqual(knownCapabilityIds(session), ['external-source.export', 'knowledge.pipeline']);
  assert.deepEqual(knownCapabilityIds(sessionBase()), []);
});

test('agent graph rejects plan steps declaring unknown capabilities', async () => {
  let calls = 0;
  let rejectionSeen = null;
  const session = sessionBase({
    agentRegistrySnapshot: orchestrableAgentSnapshot(),
    llm: {
      async completeWithTools({ messages }) {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'plan-call',
              type: 'function',
              function: {
                name: 'wiki__plan_set',
                arguments: JSON.stringify({
                  steps: [
                    { id: 'create', description: 'Create config file', requiredCapability: 'file.creation' },
                    { id: 'validate', description: 'Validate config', requiredCapability: 'file.validation', dependsOn: ['create'] },
                  ],
                }),
              },
            }],
          };
        }
        rejectionSeen = messages.map((message) => String(message.content ?? '')).join('\n');
        return {
          content: 'Understood, no plan registered.',
          message: { role: 'assistant', content: 'Understood, no plan registered.' },
          tool_calls: null,
        };
      },
    },
  });

  const agent = createAgentGraph();
  await agent.invoke({ input: 'Configure CME', session });

  assert.equal(session.headlessPlan ?? null, null, 'rejected plan must not be registered');
  assert.match(rejectionSeen ?? '', /Plan rejected: unknown capabilities \[file\.creation, file\.validation\]/);
  assert.match(rejectionSeen ?? '', /external-source\.export, knowledge\.pipeline/);
});

test('agent graph accepts plan steps with known capabilities and null capability', async () => {
  let calls = 0;
  const session = sessionBase({
    agentRegistrySnapshot: orchestrableAgentSnapshot(),
    llm: {
      async completeWithTools() {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'plan-call',
              type: 'function',
              function: {
                name: 'wiki__plan_set',
                arguments: JSON.stringify({
                  steps: [
                    { id: 'export', description: 'Export sources', requiredCapability: 'external-source.export' },
                    { id: 'report', description: 'Summarize results', requiredCapability: null, dependsOn: ['export'] },
                  ],
                }),
              },
            }],
          };
        }
        return {
          content: 'Plan ready.',
          message: { role: 'assistant', content: 'Plan ready.' },
          tool_calls: null,
        };
      },
    },
  });

  const agent = createAgentGraph();
  const result = await agent.invoke({ input: 'Export then report', session });

  assert.equal(result.response, 'Plan ready.');
  assert.deepEqual(session.headlessPlan.map((step) => step.id), ['export', 'report']);
});

test('buildAgentSystemPrompt assigns capability resolution exclusively to the runtime', () => {
  const withAgents = buildAgentSystemPrompt({ session: sessionBase({ agentRegistrySnapshot: orchestrableAgentSnapshot() }) });
  assert.match(withAgents, /call runtime__delegate with the user objective only/);
  assert.match(withAgents, /Never choose a capability, operation, agent, plan, or implementation yourself/);
  assert.doesNotMatch(withAgents, /ONLY values allowed in requiredCapability/);
});

test('agent graph executes action inputs inside a runtime run instead of asking for clarification', async () => {
  // Regression: during a runtime run agentProjection.status is 'running', so
  // the interactive classifier turned every action verb into 'ambiguous' and
  // returned a canned clarification — "lance l'ingestion" did nothing.
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
    };
  };
  const session = sessionBase({
    agentProjection: { status: 'running', conversation: [], activities: [] },
    _currentRunIdentity: { runId: 'run-ingest', turnId: 'run-ingest:turn-1', workspace: 'docs' },
    llm: toolCallingLlm(),
  });

  try {
    const agent = createAgentGraph();
    const result = await agent.invoke({ input: "lance l'ingestion des documents", session });

    assert.equal(result.response, 'Done.');
    assert.equal(fetchCalls, 1, 'the MCP tool must actually be called');
    assert.doesNotMatch(result.response, /Peux-tu préciser/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent graph lets Donna handle ambiguous input during a run with the control suite', async () => {
  // The canned "Peux-tu préciser ?" regex answer is gone: Donna converses,
  // armed with status/enqueue/cancel/kill/approve — and without write tools
  // (a new MCP job must not fire alongside the active run).
  const seenTools = [];
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    agentProjection: { status: 'running', conversation: [], activities: [] },
    llm: {
      async completeWithTools({ tools }) {
        seenTools.push(...tools.map((tool) => tool.function.name));
        return {
          content: 'Un run est en cours — je peux le mettre en file pour après, veux-tu ?',
          message: { role: 'assistant', content: 'Un run est en cours — je peux le mettre en file pour après, veux-tu ?' },
          tool_calls: null,
        };
      },
    },
  });

  const agent = createAgentGraph();
  const result = await agent.invoke({ input: 'lance un build', session });

  assert.match(result.response, /mettre en file/);
  assert.ok(seenTools.includes('runtime__enqueue'));
  assert.ok(seenTools.includes('runtime__status'));
  assert.ok(seenTools.includes('runtime__approve'));
  assert.ok(!seenTools.includes('production__production_start_job'), 'no write MCP tools during an active run for ambiguous intents');
});

test('agent graph survives more than 12 tool iterations (recursion limit)', async () => {
  // LangGraph's default recursionLimit (25) killed real runs around the 12th
  // tool round with GRAPH_RECURSION_LIMIT. 20 rounds must now pass.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
  });
  let calls = 0;
  const session = sessionBase({
    _currentRunIdentity: { runId: 'run-long', turnId: 'run-long:turn-1', workspace: 'docs' },
    llm: {
      async completeWithTools() {
        calls += 1;
        if (calls <= 20) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: `call-${calls}`,
              type: 'function',
              function: { name: 'production__production_start_job', arguments: '{"type":"doctor"}' },
            }],
          };
        }
        return { content: 'Terminé.', message: { role: 'assistant', content: 'Terminé.' }, tool_calls: null };
      },
    },
  });

  try {
    const agent = createAgentGraph();
    const result = await agent.invoke({ input: 'inspecte tout puis lance le doctor', session });
    assert.equal(result.response, 'Terminé.');
    assert.equal(calls, 21);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime action retries a text-only hallucination and requires a real tool call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true,"outputs":["deliverables/result.md"]}' }] } }),
  });
  let calls = 0;
  let retryMessages = [];
  const session = sessionBase({
    _currentRunIdentity: { runId: 'run-build', turnId: 'run-build:turn-1', workspace: 'docs' },
    llm: {
      async completeWithTools({ messages }) {
        calls += 1;
        if (calls === 1) {
          return {
            content: 'Build terminé, faux-job-123, rapport.pdf.',
            message: { role: 'assistant', content: 'Build terminé, faux-job-123, rapport.pdf.' },
            tool_calls: null,
          };
        }
        if (calls === 2) {
          retryMessages = messages;
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'build-call',
              type: 'function',
              function: { name: 'production__production_start_job', arguments: '{"type":"build"}' },
            }],
          };
        }
        return {
          content: 'Build terminé. Résultat : deliverables/result.md. Disponible dans /openui.',
          message: { role: 'assistant', content: 'Build terminé. Résultat : deliverables/result.md. Disponible dans /openui.' },
          tool_calls: null,
        };
      },
    },
  });

  try {
    const result = await createAgentGraph().invoke({ input: 'lance le build', session });
    assert.equal(calls, 3);
    assert.match(retryMessages.at(-1).content, /called no tool/);
    assert.doesNotMatch(result.response, /faux-job-123|rapport\.pdf/);
    assert.match(result.response, /deliverables\/result\.md/);
    assert.equal(session.headlessPlan?.[0]?.status, 'done');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent graph auto-declares the plan from an agent_plan task-graph fragment', async () => {
  // The bridge that makes parallel ingestion real: when the LLM calls
  // production__agent_plan, the shell integrates the fragment as the plan
  // deterministically (no lossy LLM copying) with the execution fields the
  // dispatcher needs (operation, arguments, groups, barrier).
  const fragment = {
    capability: 'knowledge.update',
    tasks: [
      { id: 'ingest:a', label: 'Ingest a.md', requiredCapability: 'knowledge.update', operation: 'ingest_plan', arguments: { inputs: ['raw/untracked/a.md'] }, dependsOn: [], parallelizable: true, groupId: 'ingest', expectedOutputRefs: [{ type: 'file', ref: '.wiki/plans/a.json' }], requiresApproval: true, idempotencyKey: 'k'.repeat(64) },
      { id: 'ingest:b', label: 'Ingest b.md', requiredCapability: 'knowledge.update', operation: 'ingest_plan', arguments: { inputs: ['raw/untracked/b.md'] }, dependsOn: [], parallelizable: true, groupId: 'ingest', expectedOutputRefs: [{ type: 'file', ref: '.wiki/plans/b.json' }], requiresApproval: true, idempotencyKey: 'k'.repeat(64) },
      { id: 'ingest-apply', label: 'Apply ingest plans', requiredCapability: 'knowledge.update', operation: 'ingest_apply', arguments: { inputs: ['.wiki/plans/a.json', '.wiki/plans/b.json'] }, dependsOn: ['ingest:a', 'ingest:b'], barrier: true, dependsOnGroup: 'ingest', requiresApproval: true, idempotencyKey: 'k'.repeat(64) },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(fragment) }] } }),
  });
  let calls = 0;
  const session = sessionBase({
    mcp: {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        tools: [{ name: 'agent_plan', description: 'Propose a task graph', inputSchema: { type: 'object', properties: {} } }],
      },
    },
    llm: {
      async completeWithTools() {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'plan-call',
              type: 'function',
              function: { name: 'production__agent_plan', arguments: JSON.stringify({ capability: 'knowledge.update', operation: 'ingest' }) },
            }],
          };
        }
        return { content: 'Plan intégré, en attente du dispatch.', message: { role: 'assistant', content: 'Plan intégré, en attente du dispatch.' }, tool_calls: null };
      },
    },
  });

  try {
    const agent = createAgentGraph();
    const result = await agent.invoke({ input: 'ingère les documents en attente', session });

    assert.equal(result.response, 'Plan intégré, en attente du dispatch.');
    assert.equal(session.headlessPlan.length, 3);
    assert.deepEqual(session.headlessPlan.map((step) => step.operation), ['ingest_plan', 'ingest_plan', 'ingest_apply']);
    assert.deepEqual(session.headlessPlan[0].arguments, { inputs: ['raw/untracked/a.md'] });
    assert.equal(session.headlessPlan[0].parallelizable, true);
    assert.equal(session.headlessPlan[2].barrier, true);
    assert.deepEqual(session.headlessPlan[2].dependsOn, ['ingest:a', 'ingest:b']);
    assert.equal(session.headlessPlan[0].requiredCapability, 'knowledge.update');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Donna interprets a cleanup request and calls runtime__kill herself', async () => {
  // "supprime le job et la queue" previously hit a regex classifier that
  // answered with canned text. Donna now owns runtime control tools.
  let killPath = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    killPath = new URL(String(url)).pathname;
    return { ok: true, status: 202, json: async () => ({ killed: true, runs: 1, tasks: 2, queued: 2 }), text: async () => '{}', headers: { get: () => null } };
  };
  let calls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    agentProjection: { status: 'running', activities: [], conversation: [] },
    llm: {
      async completeWithTools({ tools }) {
        calls += 1;
        if (calls === 1) {
          const names = tools.map((tool) => tool.function.name);
          assert.ok(names.includes('runtime__kill'), 'control tools must be bound during an active run');
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{ id: 'kill-call', type: 'function', function: { name: 'runtime__kill', arguments: '{}' } }],
          };
        }
        return { content: 'Run et queue purgés.', message: { role: 'assistant', content: 'Run et queue purgés.' }, tool_calls: null };
      },
    },
  });

  try {
    const agent = createAgentGraph();
    const result = await agent.invoke({ input: 'supprime le job et la queue', session });
    assert.equal(result.response, 'Run et queue purgés.');
    assert.equal(killPath, '/kill');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Donna refuses a direct mutating provider tool in interactive mode and is steered to delegation', async () => {
  const fetchedHosts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchedHosts.push(new URL(String(url)).host);
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', headers: { get: () => null } };
  };
  let calls = 0;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    llm: {
      async completeWithTools({ tools, messages }) {
        calls += 1;
        if (calls === 1) {
          const names = tools.map((tool) => tool.function.name);
          assert.ok(!names.includes('production__production_start_job'), 'a mutating provider tool must not be offered in interactive mode');
          assert.ok(names.includes('runtime__delegate'), 'delegate must be offered in interactive mode');
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{ id: 'direct-call', type: 'function', function: { name: 'production__production_start_job', arguments: '{"type":"ingest"}' } }],
          };
        }
        const lastTool = (messages ?? []).filter((message) => message.role === 'tool').at(-1);
        assert.match(String(lastTool?.content ?? ''), /not available in interactive mode/);
        return { content: 'Objectif transmis au runtime.', message: { role: 'assistant', content: 'Objectif transmis au runtime.' }, tool_calls: null };
      },
    },
  });

  try {
    const agent = createAgentGraph();
    const result = await agent.invoke({ input: 'lance une ingestion', session });
    assert.equal(calls, 2, 'the model must get a second turn after the refusal');
    assert.equal(result.response, 'Objectif transmis au runtime.');
    assert.ok(!fetchedHosts.includes('127.0.0.1:3000'), 'the refused provider tool must never be executed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chatAccess config drives which MCP tools Donna is offered in chat', async () => {
  let names = null;
  const session = sessionBase({
    runtime: { url: 'http://runtime.test' },
    chatAccess: { servers: { production: { allow: ['production_status'] } } },
    mcp: {
      production: {
        status: 'connected',
        tools: [
          { name: 'production_status', description: 'read', inputSchema: { type: 'object', properties: {} } },
          { name: 'production_start_job', description: 'write', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    },
    llm: {
      async completeWithTools({ tools }) {
        if (names === null) names = tools.map((tool) => tool.function.name);
        return { content: 'ok', message: { role: 'assistant', content: 'ok' }, tool_calls: null };
      },
    },
  });
  const agent = createAgentGraph();
  await agent.invoke({ input: 'statut ?', session });
  assert.ok(names.includes('production__production_status'), 'chatAccess-allowed tool is offered');
  assert.ok(!names.includes('production__production_start_job'), 'a tool absent from the chatAccess allow-list is not offered');
});

test('buildAgentSystemPrompt uses the canonical wiki workspace status without filesystem fallback', () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'facts-'));
  try {
    mkdirSync(join(workspacePath, 'raw', 'untracked'), { recursive: true });
    writeFileSync(join(workspacePath, 'raw', 'untracked', 'note-a.md'), '# a\n');
    const prompt = buildAgentSystemPrompt({ session: sessionBase({ workspacePath }) });
    assert.match(prompt, /call wiki__wiki_workspace_status first/);
    assert.match(prompt, /canonical read-only workspace state/);
    assert.doesNotMatch(prompt, /note-a\.md/);
    assert.doesNotMatch(prompt, /Workspace facts:/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('Donna reads workspace inventory from the canonical wiki status tool', async () => {
  const originalFetch = globalThis.fetch;
  let requestedArguments = null;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requestedArguments = request.params.arguments;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{
        type: 'text',
        text: JSON.stringify({
          pendingSources: { count: 2, files: ['raw/untracked/a.md', 'raw/untracked/b.md'] },
          templates: { count: 1, files: ['templates/report.md'] },
          deliverables: { count: 0, files: [] },
        }),
      }] } }),
    };
  };
  let calls = 0;
  const session = sessionBase({
    mcp: {
      wiki: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        tools: [{
          name: 'wiki_workspace_status',
          description: 'Read the canonical local workspace inventory.',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    },
    llm: {
      async completeWithTools({ messages }) {
        calls += 1;
        if (calls === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [{
              id: 'status-call',
              type: 'function',
              function: { name: 'wiki__wiki_workspace_status', arguments: '{}' },
            }],
          };
        }
        assert.match(JSON.stringify(messages), /raw\/untracked\/a\.md/);
        return { content: 'Deux fichiers sont en attente : a.md et b.md.', message: { role: 'assistant', content: 'Deux fichiers sont en attente : a.md et b.md.' }, tool_calls: null };
      },
    },
  });

  try {
    const result = await createAgentGraph().invoke({ input: 'as ton des fichier en attente d ingestion', session });
    assert.equal(result.response, 'Deux fichiers sont en attente : a.md et b.md.');
    assert.deepEqual(requestedArguments, {});
    assert.equal(session.headlessPlan, null, 'a read-only workspace inventory must not create a plan');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
