import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentGraph } from '../agent/graph.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { runRuntimeAgenticWorkflow, runRuntimeParallelPlan } from './runner.js';
import { startRuntimeServer } from './server.js';

// Executable version of plan-0.11.5-hotfix-final.md §3 ("La recette — le seul
// critère de sortie qui compte"). Each test below is one row of that table,
// referenced by its recipe number. Correctifs 1-3 and 8 (runner.js's
// conversational short-circuit, plan sanitization, and no-replan-on-vague
// paths) are exercised with a mocked agent standing in for the LLM's
// per-turn decision, exactly like the existing runner.test.js unit tests --
// this file's job is traceability to the recipe, not a new test seam.
// Recipes 4-6 drive the real scheduler (runAgenticLoop / runRuntimeParallelPlan,
// imported and executed for real, never reimplemented). Recipe 7 drives the
// real control-lane HTTP endpoint. Per plan §4.1: this file is the CI gate --
// no release ships while it is red.

function baseSession(overrides = {}) {
  return { activities: {}, headlessPlan: null, ...overrides };
}

function eventTypes(session) {
  return (session.agentEvents ?? []).map((event) => event.type);
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition was not met before timeout');
}

test('Recipe #1 — "salut" gets a plain reply: no plan, no activity, no job, run done', async () => {
  const session = baseSession({
    llm: {
      async completeWithTools() {
        assert.fail('a plain greeting must never reach the evaluator or replanner');
      },
    },
  });
  const agent = {
    async invoke() {
      return { response: 'Bonjour ! Comment puis-je vous aider ?' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'salut', {
    runId: 'recipe-1',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan, null);
  assert.equal(Object.keys(session.activities).length, 0);
  const types = eventTypes(session);
  assert.ok(types.includes('run_done'));
  assert.equal(types.includes('run_evaluated'), false);
  assert.equal(types.includes('run_replanned'), false);
  assert.equal(types.includes('tool_call_started'), false);
  assert.equal(types.includes('plan_set'), false);
});

test('Recipe #2 — "quel est le profil actif ?" answers in conversation, never poses a plan', async () => {
  const session = baseSession({
    llm: {
      async completeWithTools() {
        assert.fail('a read-only config question must never reach the evaluator or replanner');
      },
    },
  });
  const agent = {
    async invoke({ session: turnSession }) {
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_started', {
        origin: 'tool',
        payload: { name: 'shell.status', args: '{}', summary: 'calling...' },
      }));
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_result', {
        origin: 'tool',
        payload: { name: 'shell.status', ok: true, result: 'profile: albert-openai (mistral-large)', summary: 'done' },
      }));
      return { response: 'Le profil actif est albert-openai (mistral-large).' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'quel est le profil actif ?', {
    runId: 'recipe-2',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan, null);
  const types = eventTypes(session);
  assert.ok(types.includes('tool_call_started'));
  assert.ok(types.includes('run_done'));
  assert.equal(types.includes('plan_set'), false);
  assert.equal(types.includes('run_evaluated'), false);
});

test('Recipe #3 — "où en est le dernier build ?" reads status, starts no new production run', async () => {
  const session = baseSession({
    llm: {
      async completeWithTools() {
        assert.fail('a status question must never reach the evaluator or replanner');
      },
    },
  });
  const agent = {
    async invoke({ session: turnSession }) {
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_started', {
        origin: 'tool',
        payload: { name: 'production.production_job_status', args: '{}', summary: 'calling...' },
      }));
      dispatchAgentEvent(turnSession, createAgentEvent('tool_call_result', {
        origin: 'tool',
        payload: { name: 'production.production_job_status', ok: true, result: 'last build: done', summary: 'done' },
      }));
      return { response: 'Le dernier build est terminé avec succès.' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'où en est le dernier build ?', {
    runId: 'recipe-3',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan, null);
  assert.equal(Object.keys(session.activities).length, 0);
  const types = eventTypes(session);
  assert.equal(types.includes('activity_upserted'), false);
  assert.equal(types.includes('plan_set'), false);
});

test('CME setup and source configuration stay outside export orchestration', async () => {
  const originalFetch = globalThis.fetch;
  const calledTools = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body ?? '{}'));
    calledTools.push(body.params?.name);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
    };
  };
  let turn = 0;
  const session = baseSession({
    commands: ['status'],
    workspace: 'demo-workspace',
    mcp: {
      cme: {
        status: 'connected',
        url: 'http://127.0.0.1:3010/mcp/',
        tools: [
          { name: 'cme_setup', inputSchema: { type: 'object', additionalProperties: true } },
          { name: 'cme_source_add', inputSchema: { type: 'object', additionalProperties: true } },
          { name: 'cme_export_run', inputSchema: { type: 'object', additionalProperties: true } },
        ],
      },
    },
    llm: {
      async completeWithTools() {
        turn += 1;
        if (turn === 1) {
          return {
            content: null,
            message: { role: 'assistant', content: null },
            tool_calls: [
              {
                id: 'setup',
                type: 'function',
                function: {
                  name: 'cme__cme_setup',
                  arguments: JSON.stringify({ workspace: 'demo-workspace', base_url: 'https://confluence.example', username: 'user@example.com', pat: 'token' }),
                },
              },
              {
                id: 'source',
                type: 'function',
                function: {
                  name: 'cme__cme_source_add',
                  arguments: JSON.stringify({ workspace: 'demo-workspace', name: 'docs', base_url: 'https://confluence.example', space: 'DOC' }),
                },
              },
            ],
          };
        }
        return {
          content: 'CME est configuré.',
          message: { role: 'assistant', content: 'CME est configuré.' },
          tool_calls: null,
        };
      },
    },
  });

  try {
    const result = await runRuntimeAgenticWorkflow(createAgentGraph(), session, 'configure cme', {
      runId: 'cme-config',
      timeoutMs: 1000,
      maxTurns: 2,
      evaluate: false,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calledTools, ['cme_setup', 'cme_source_add']);
    assert.equal(calledTools.includes('cme_export_run'), false);
    assert.equal((session.headlessPlan ?? []).some((step) => step.requiredCapability === 'external-source.export'), false);
    assert.equal((session.headlessPlan ?? []).some((step) => step.operation === 'export'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CME export is dispatched only from an approved DAG task', async () => {
  let executeCalls = 0;
  const session = baseSession({
    workspace: 'demo-workspace',
    mcp: {
      cme: {
        status: 'connected',
        tools: [{ name: 'agent_execute' }, { name: 'agent_status' }, { name: 'agent_cancel' }],
      },
    },
    agentRegistrySnapshot: [cmeAgent()],
    wikircConfig: { capabilityRouting: {} },
    approvals: [],
    headlessPlan: [plannedCmeExportTask({ status: 'waiting_approval' })],
  });
  const callTool = async (_mcp, _serverName, toolName) => {
    if (toolName === 'agent_execute') executeCalls += 1;
    throw new Error(`unexpected tool: ${toolName}`);
  };

  const result = await runRuntimeParallelPlan({ invoke: async () => assert.fail('no child loop') }, session, 'export cme', {
    runId: 'cme-export-approval',
    timeoutMs: 100,
    maxTurns: 1,
    callTool,
    dispatcherPollIntervalMs: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stalled, true);
  assert.equal(result.reason, 'awaiting_approval');
  assert.equal(executeCalls, 0);
  assert.equal(session.headlessPlan[0].status, 'waiting_approval');
});

function buildSingleTaskAgent({ taskId, description, finalResponse }) {
  let turn = 0;
  return {
    async invoke({ session: turnSession }) {
      turn += 1;
      if (turn === 1) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: { steps: [{ step: 1, id: taskId, description, status: 'pending', dependsOn: [] }] },
        }));
        return { response: `Je lance ${description}.` };
      }
      dispatchAgentEvent(turnSession, createAgentEvent('plan_step_updated', {
        origin: 'tool',
        payload: { step: 1, status: 'done' },
      }));
      return { response: finalResponse };
    },
  };
}

test('Recipe #4 — "lance le doctor": one-task plan, progress visible, summarized result', async () => {
  const session = baseSession();
  const agent = buildSingleTaskAgent({
    taskId: 'doctor',
    description: 'Diagnostic doctor',
    finalResponse: 'Doctor terminé : aucun problème détecté.',
  });

  const result = await runRuntimeAgenticWorkflow(agent, session, 'lance le doctor', {
    runId: 'recipe-4',
    timeoutMs: 1000,
    maxTurns: 3,
    maxReplans: 1,
    evaluate: false,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan.length, 1);
  assert.equal(session.headlessPlan[0].status, 'done');
  const types = eventTypes(session);
  assert.deepEqual(types.filter((type) => type === 'plan_set' || type === 'plan_step_updated'), ['plan_set', 'plan_step_updated']);
  assert.ok(types.includes('run_done'));
  assert.equal(session.agentProjection.conversation.at(-1).content, 'Doctor terminé : aucun problème détecté.');
});

test('Recipe #5 — "construis le livrable X": plan posed, job runs, progress, done, summarized', async () => {
  const session = baseSession();
  const agent = buildSingleTaskAgent({
    taskId: 'build-x',
    description: 'Construire le livrable X',
    finalResponse: 'Le livrable X est construit.',
  });

  const result = await runRuntimeAgenticWorkflow(agent, session, 'construis le livrable X', {
    runId: 'recipe-5',
    timeoutMs: 1000,
    maxTurns: 3,
    maxReplans: 1,
    evaluate: false,
  });

  assert.equal(result.ok, true);
  assert.equal(session.headlessPlan[0].status, 'done');
  assert.ok(eventTypes(session).includes('run_done'));
  assert.equal(session.agentProjection.conversation.at(-1).content, 'Le livrable X est construit.');
});

function buildTwoParallelTasksAgent() {
  let parentTurnDone = false;
  return {
    async invoke({ session: turnSession }) {
      if (!parentTurnDone) {
        parentTurnDone = true;
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: {
            steps: [
              plannedDoctorTask('x', []),
              plannedDoctorTask('y', []),
            ],
          },
        }));
        return { response: 'Je construis X et Y en parallèle.' };
      }
      assert.fail('contractual tasks must be dispatched through agent tools, not child Donna turns');
    },
  };
}

test('Recipe #6 — "construis X et Y": two tasks run in parallel, converge, done', async () => {
  const completed = new Set();
  const jobs = new Map();
  const executeOrder = [];
  const session = baseSession({
    workspace: 'demo-workspace',
    mcp: {
      production: {
        status: 'connected',
        tools: [{ name: 'agent_execute' }, { name: 'agent_status' }, { name: 'agent_cancel' }],
      },
    },
    agentRegistrySnapshot: [productionAgent()],
    wikircConfig: { capabilityRouting: {} },
  });
  const agent = buildTwoParallelTasksAgent();
  const callTool = async (_mcp, _serverName, toolName, args) => {
    if (toolName === 'agent_execute') {
      executeOrder.push(args.taskId);
      const jobId = `job-${args.taskId}`;
      jobs.set(jobId, { jobId, taskId: args.taskId });
      return toolResult({ accepted: true, jobId, status: 'queued' });
    }
    if (toolName === 'agent_status') {
      const job = jobs.get(args.jobId);
      const done = completed.has(job.taskId);
      return toolResult({
        jobId: job.jobId,
        taskId: job.taskId,
        operation: 'doctor',
        status: done ? 'done' : 'running',
        progress: { percent: done ? 100 : 50 },
        ...(done ? { result: { status: 'succeeded', outputRefs: [], metrics: { durationMs: 1 } } } : {}),
      });
    }
    if (toolName === 'agent_cancel') return toolResult({ ok: true });
    throw new Error(`unexpected tool: ${toolName}`);
  };

  const running = runRuntimeAgenticWorkflow(agent, session, 'construis X et Y', {
    runId: 'recipe-6',
    timeoutMs: 2000,
    maxTurns: 3,
    maxReplans: 1,
    evaluate: false,
    callTool,
    dispatcherPollIntervalMs: 1,
  });

  await waitFor(() => executeOrder.includes('x') && executeOrder.includes('y'));
  assert.deepEqual(
    session.headlessPlan.filter((step) => ['x', 'y'].includes(step.id)).map((step) => step.status),
    ['running', 'running'],
  );
  completed.add('x');
  completed.add('y');

  const result = await running;

  assert.equal(result.ok, true);
  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done']);
});

function plannedDoctorTask(id, dependsOn) {
  return {
    step: id === 'x' ? 1 : 2,
    id,
    label: `Construire ${id.toUpperCase()}`,
    description: `Construire ${id.toUpperCase()}`,
    status: 'pending',
    dependsOn,
    requiredCapability: 'workspace.diagnose',
    operation: 'doctor',
    arguments: {},
    parallelizable: true,
    inputRefs: [],
    expectedOutputRefs: [],
    locks: [],
    requiresApproval: false,
    idempotencyKey: null,
    progressWeight: 1,
    outputRefs: [],
  };
}

function plannedCmeExportTask(overrides = {}) {
  return {
    step: 1,
    id: 'cme-export',
    label: 'Export CME',
    description: 'Export CME',
    status: 'pending',
    dependsOn: [],
    requiredCapability: 'external-source.export',
    operation: 'export',
    arguments: { source_name: 'docs' },
    parallelizable: false,
    inputRefs: [],
    expectedOutputRefs: [{ type: 'directory', ref: 'raw/untracked' }],
    locks: ['external-source:docs'],
    requiresApproval: true,
    approvalClass: 'external-source',
    idempotencyKey: 'idem-cme-export',
    progressWeight: 1,
    outputRefs: [],
    ...overrides,
  };
}

function cmeAgent() {
  return {
    serverName: 'cme',
    agentInstanceId: 'cme-main',
    health: 'available',
    description: {
      contractVersion: '1',
      agentType: 'cme',
      agentInstanceId: 'cme-main',
      displayName: 'CME',
      capabilities: [{
        id: 'external-source.export',
        version: '1',
        description: 'Export external source',
        inputSchema: { type: 'object', additionalProperties: true },
        outputSchema: { type: 'object', additionalProperties: true },
        supportedOperations: ['export'],
        mutationClass: 'external-source',
        defaultRequiresApproval: true,
      }],
      orchestration: {
        canPlan: false,
        canExpandPlan: false,
        canExecute: true,
        canCancel: true,
        canResume: false,
        singleTaskOnly: true,
        supportsIdempotency: true,
        supportsParallelWorkers: false,
      },
      limits: { recommendedConcurrency: 1, maxConcurrency: 1, maxTaskDurationMs: 2000 },
      health: { status: 'available' },
    },
  };
}

function productionAgent() {
  return {
    serverName: 'production',
    agentInstanceId: 'production-main',
    health: 'available',
    description: {
      contractVersion: '1',
      agentType: 'production',
      agentInstanceId: 'production-main',
      displayName: 'Production',
      capabilities: [{
        id: 'workspace.diagnose',
        version: '1',
        description: 'Diagnose workspace',
        inputSchema: { type: 'object', additionalProperties: true },
        outputSchema: { type: 'object', additionalProperties: true },
        supportedOperations: ['doctor'],
      }],
      orchestration: {
        canPlan: true,
        canExpandPlan: false,
        canExecute: true,
        canCancel: true,
        canResume: false,
        supportsIdempotency: false,
        supportsParallelWorkers: true,
      },
      limits: { recommendedConcurrency: 2, maxConcurrency: 2, maxTaskDurationMs: 2000 },
      health: { status: 'available' },
    },
  };
}

function toolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

test('Recipe #7 — "où en es-tu ?" during an active run: status in conversation, run continues, no new run', async (t) => {
  const session = { workspace: 'acme', controlQueue: [] };
  let runCount = 0;
  let handle;
  try {
    handle = await startRuntimeServer({
      host: '127.0.0.1',
      port: 0,
      store: {
        dbPath: ':memory:',
        getState: () => ({
          status: 'running',
          plan: [{ step: 1, description: 'Construire le livrable X', status: 'running' }],
          queue: [],
          approvals: [],
          summary: null,
        }),
        listEvents: () => [],
      },
      getContext: async () => ({
        workspace: 'acme',
        session,
        running: true,
        currentAbortController: new AbortController(),
      }),
      run: async () => { runCount += 1; },
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('network listen is not permitted in this sandbox');
      return;
    }
    throw err;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/control?workspace=acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'message', input: 'où en es-tu ?' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.kind, 'observe');
    assert.match(body.explanation, /Construire le livrable X/);
    assert.equal(session.controlQueue.length, 0);
    assert.equal(runCount, 0);
  } finally {
    await handle.close();
  }
});

test('Recipe #8 — vague request gets clarification, never a job, never boilerplate', async () => {
  const session = baseSession({
    headlessPlan: [{ step: 1, id: 'task', description: 'Task', status: 'done' }],
    llm: {
      async completeWithTools({ system }) {
        assert.match(system, /strict evaluator/);
        return { content: '{"ok":false,"reason":"demande vague / objectif indefini","suggestedAction":"clarifier l objectif"}' };
      },
    },
  });
  const agent = {
    async invoke({ session: turnSession }) {
      if (turnSession.headlessPlan === null) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: { steps: [{ step: 1, id: 'task', description: 'Task', status: 'done' }] },
        }));
      }
      return { response: 'Terminé.' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'dis-moi une bêtise puis stop', {
    runId: 'recipe-8',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.clarified, true);
  const lastMessage = session.agentProjection.conversation.at(-1).content;
  assert.ok(lastMessage.includes('clarifier'));
  assert.doesNotMatch(lastMessage, /Donna is active|Plan is stalled/i);
  const types = eventTypes(session);
  assert.equal(types.includes('run_replanned'), false);
  assert.equal(types.includes('tool_call_started'), false);
});
