import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentSystemPrompt, classifyAgentInput, createAgentGraph, knownCapabilityIds } from './graph.js';

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

test('classifyAgentInput routes information requests to observe, not runs', () => {
  const session = sessionBase();
  // The original incident: a config question must never become a run.
  assert.equal(classifyAgentInput('donne moi la config du cme', session).kind, 'observe');
  assert.equal(classifyAgentInput('montre la configuration du workspace', session).kind, 'observe');
  assert.equal(classifyAgentInput('où en est le run', session).kind, 'observe');
  assert.equal(classifyAgentInput('explique le build', session).kind, 'observe');
  assert.equal(classifyAgentInput("qu'est-ce que le pipeline polish ?", session).kind, 'observe');
});

test('classifyAgentInput routes action requests to start_run without an active run', () => {
  const session = sessionBase();
  assert.equal(classifyAgentInput('lance le pipeline complet', session).kind, 'start_run');
  assert.equal(classifyAgentInput('configure le cme avec ce token', session).kind, 'start_run');
  assert.equal(classifyAgentInput('lance le run', session).kind, 'start_run');
  assert.equal(classifyAgentInput('exporte les deliverables', session).kind, 'start_run');
});

test('classifyAgentInput keeps small talk as converse and active-run branches intact', () => {
  const session = sessionBase();
  assert.equal(classifyAgentInput('bonjour', session).kind, 'converse');
  assert.equal(classifyAgentInput('merci beaucoup', session).kind, 'converse');
  const activeSession = sessionBase({ agentProjection: { status: 'running' } });
  assert.equal(classifyAgentInput('lance un build', activeSession).kind, 'ambiguous');
  assert.equal(classifyAgentInput('annule tout', activeSession).kind, 'cancel');
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

test('buildAgentSystemPrompt anchors the real capability list', () => {
  const withAgents = buildAgentSystemPrompt({ session: sessionBase({ agentRegistrySnapshot: orchestrableAgentSnapshot() }) });
  assert.match(withAgents, /Known orchestration capabilities — the ONLY values allowed in requiredCapability: external-source\.export, knowledge\.pipeline/);
  assert.match(withAgents, /Never invent capability names/);

  const withoutAgents = buildAgentSystemPrompt({ session: sessionBase() });
  assert.match(withoutAgents, /No orchestration capabilities discovered yet/);
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
