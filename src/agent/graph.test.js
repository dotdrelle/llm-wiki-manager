import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentSystemPrompt, createAgentGraph } from './graph.js';

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
