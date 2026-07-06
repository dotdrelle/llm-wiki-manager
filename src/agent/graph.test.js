import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentGraph } from './graph.js';

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

test('agent graph binds no tools for plain discussion in agent mode', async () => {
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
  assert.deepEqual(seenTools, []);
  assert.equal(session.headlessPlan ?? null, null);
  assert.equal(Object.keys(session.activities ?? {}).length, 0);
});

test('agent graph binds read-only tools for config questions without plan tools', async () => {
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
  assert.equal(seenTools.includes('wiki__plan_set'), false);
  assert.equal(seenTools.includes('production__production_start_job'), false);
  assert.equal(seenTools.includes('shell__run_command'), false);
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

test('agent graph accepts structured wiki plan steps and selects MCP executors', async () => {
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
                    { id: 'cme-export', description: 'Export CME pages', outputRefs: ['raw/untracked'] },
                    { id: 'build', description: 'Run production build', dependsOn: ['cme-export'] },
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
  assert.equal(session.headlessPlan[0].executor, 'cme.cme_export_run');
  assert.equal(session.headlessPlan[1].executor, 'production.production_start_job');
  assert.deepEqual(session.headlessPlan[1].dependsOn, ['cme-export']);
  assert.deepEqual(session.headlessPlan[0].outputRefs, ['raw/untracked']);
});
