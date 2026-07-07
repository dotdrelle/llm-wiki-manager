import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { finishRuntimeRun, replanRuntimeRun, runRuntimeAgenticWorkflow, runRuntimeParallelPlan } from './runner.js';

test('runRuntimeAgenticWorkflow completes conversational turns without evaluation or replan', async () => {
  const events = [];
  const session = {
    activities: {},
    headlessPlan: null,
    llm: {
      async completeWithTools() {
        assert.fail('conversation-only turn must not call evaluator or replanner');
      },
    },
    _onAgentEvent: (event) => events.push(event),
  };
  const agent = {
    async invoke() {
      return { response: 'Salut.' };
    },
  };

  const started = Date.now();
  const result = await runRuntimeAgenticWorkflow(agent, session, 'salut', {
    runId: 'run-chat',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 5000);
  assert.equal(session.headlessPlan, null);
  assert.equal(Object.keys(session.activities).length, 0);
  assert.ok(events.some((event) => event.type === 'run_done'));
  assert.equal(events.some((event) => event.type === 'run_evaluated'), false);
  assert.equal(events.some((event) => event.type === 'run_replanned'), false);
});

test('finishRuntimeRun emits evaluation before run_done', async () => {
  const events = [];
  const session = {
    activities: {},
    headlessPlan: [
      { step: 1, description: 'Analyze', status: 'done' },
      { step: 2, description: 'Execute', status: 'done' },
    ],
    agentProjection: {
      conversation: [{ role: 'assistant', content: 'Done.' }],
    },
    llm: {
      async completeWithTools({ system, tools, messages }) {
        assert.match(system, /strict evaluator/);
        assert.deepEqual(tools, []);
        assert.match(messages[0].content, /Original task:/);
        return { content: '{"ok":true,"reason":"Task complete.","suggestedAction":null}' };
      },
    },
    _onAgentEvent: (event) => events.push(event),
  };

  const result = await finishRuntimeRun(session, 'Build workspace', { runId: 'run-1' });

  assert.equal(result.ok, true);
  assert.deepEqual(events.map((event) => event.type), ['runtime_log', 'run_evaluated', 'run_done']);
  assert.equal(session.agentProjection.evaluation.ok, true);
  assert.equal(session.agentProjection.status, 'done');
});

test('runRuntimeAgenticWorkflow clarifies vague evaluations without replan', async () => {
  const events = [];
  const session = {
    activities: {},
    headlessPlan: [{ step: 1, id: 'task', description: 'Task', status: 'done' }],
    llm: {
      async completeWithTools({ system }) {
        assert.match(system, /strict evaluator/);
        return { content: '{"ok":false,"reason":"demande vague / objectif indefini","suggestedAction":"clarifier l objectif"}' };
      },
    },
    _onAgentEvent: (event) => events.push(event),
  };
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

  const result = await runRuntimeAgenticWorkflow(agent, session, 'fais le truc', {
    runId: 'run-vague',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.clarified, true);
  assert.ok(session.agentProjection.conversation.at(-1).content.includes('clarifier'));
  assert.ok(events.some((event) => event.type === 'run_evaluated'));
  assert.equal(events.some((event) => event.type === 'run_replanned'), false);
  assert.equal(events.some((event) => event.type === 'tool_call_started'), false);
  assert.equal(session.agentProjection.status, 'done');
});

test('finishRuntimeRun turns negative evaluation into run_error', async () => {
  const events = [];
  const session = {
    activities: {},
    headlessPlan: [{ step: 1, description: 'Export', status: 'done' }],
    agentProjection: {
      conversation: [{ role: 'assistant', content: 'Done.' }],
    },
    llm: {
      async completeWithTools() {
        return { content: '{"ok":false,"reason":"Export file missing.","suggestedAction":"Run export again."}' };
      },
    },
    _onAgentEvent: (event) => events.push(event),
  };

  const result = await finishRuntimeRun(session, 'Export deliverable', { runId: 'run-2' });

  assert.equal(result.ok, false);
  assert.equal(result.evaluationRejected, true);
  assert.deepEqual(events.map((event) => event.type), ['runtime_log', 'run_evaluated', 'run_error']);
  assert.equal(session.agentProjection.evaluation.ok, false);
  assert.equal(session.agentProjection.status, 'error');
  assert.match(session.agentProjection.logs.at(-1), /Export file missing/);
});

test('finishRuntimeRun falls back open when evaluator response is invalid', async () => {
  const session = {
    activities: {},
    headlessPlan: [{ step: 1, description: 'Do work', status: 'done' }],
    agentProjection: { conversation: [] },
    llm: {
      async completeWithTools() {
        return { content: 'not json' };
      },
    },
  };

  const result = await finishRuntimeRun(session, 'Do work', { runId: 'run-3' });

  assert.equal(result.ok, true);
  assert.equal(session.agentProjection.evaluation.ok, true);
  assert.match(session.agentProjection.evaluation.reason, /Evaluator unavailable/);
  assert.equal(session.agentProjection.status, 'done');
});

test('finishRuntimeRun can skip evaluation', async () => {
  let called = false;
  const session = {
    activities: {},
    headlessPlan: null,
    agentProjection: { conversation: [] },
    llm: {
      async completeWithTools() {
        called = true;
        return { content: '{"ok":true,"reason":"ok"}' };
      },
    },
  };

  const result = await finishRuntimeRun(session, 'Do work', { runId: 'run-4', evaluate: false });

  assert.equal(result.ok, true);
  assert.equal(result.evaluation, null);
  assert.equal(called, false);
  assert.equal(session.agentProjection.evaluation, null);
  assert.equal(session.agentProjection.status, 'done');
});

test('runRuntimeAgenticWorkflow replans after negative evaluation', async () => {
  const events = [];
  const llmCalls = [];
  const session = {
    activities: {},
    headlessPlan: null,
    llm: {
      async completeWithTools({ system }) {
        llmCalls.push(system);
        if (/strict evaluator/.test(system) && llmCalls.length === 1) {
          return { content: '{"ok":false,"reason":"Export missing.","suggestedAction":"Run export."}' };
        }
        if (/replanner/.test(system)) {
          return { content: '{"steps":["Run export"]}' };
        }
        return { content: '{"ok":true,"reason":"Export complete.","suggestedAction":null}' };
      },
    },
    _onAgentEvent: (event) => events.push(event),
  };
  let turns = 0;
  const agent = {
    async invoke({ session: turnSession }) {
      turns += 1;
      if (turnSession.headlessPlan === null) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: { steps: [{ step: 1, id: 'initial', description: 'Initial work', status: 'done' }] },
        }));
        return { response: 'Initial done.' };
      }
      const pending = turnSession.headlessPlan?.find((step) => step.status === 'pending');
      if (pending) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_step_updated', {
          origin: 'tool',
          payload: { taskId: pending.id, status: 'done' },
        }));
      }
      return { response: 'Export done.' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'Export deliverable', {
    runId: 'run-replan-eval',
    timeoutMs: 1000,
    maxTurns: 2,
    maxReplans: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(turns, 2);
  assert.ok(events.some((event) => event.type === 'run_replanned'));
  assert.deepEqual(session.agentProjection.replans[0].plan, ['Run export']);
  assert.equal(session.agentProjection.status, 'done');
});

test('replanRuntimeRun preserves completed outputs when replacing remaining work', async () => {
  const session = {
    activities: {},
    headlessPlan: [
      { step: 1, id: 'export', description: 'Export', status: 'done', outputRefs: ['raw/export.json'] },
      { step: 2, id: 'build', description: 'Build', status: 'failed' },
    ],
    llm: {
      async completeWithTools() {
        return { content: '{"steps":["Retry build"]}' };
      },
    },
  };

  const result = await replanRuntimeRun(session, 'Build deliverable', {
    kind: 'activity_error',
    reason: 'Build failed.',
  }, { runId: 'run-replan-preserve', replansLeft: 1 });

  assert.equal(result.ok, true);
  assert.deepEqual(session.headlessPlan.map((step) => step.id), ['export', 'replan-1']);
  assert.deepEqual(session.headlessPlan[0].outputRefs, ['raw/export.json']);
  assert.deepEqual(session.headlessPlan[1].dependsOn, ['export']);
});

test('replanRuntimeRun requires runtime approval for mutating replanned work', async () => {
  const session = {
    activities: {},
    headlessPlan: [{ step: 1, id: 'build', description: 'Build', status: 'failed' }],
    llm: {
      async completeWithTools() {
        return { content: '{"steps":["Run production build"]}' };
      },
    },
  };

  const result = await replanRuntimeRun(session, 'Build deliverable', {
    kind: 'evaluation',
    reason: 'Build missing.',
  }, { runId: 'run-replan-approval', replansLeft: 1 });

  assert.equal(result.ok, true);
  assert.equal(session._runApprovalRequired, true);
  assert.equal(session._runApprovalResolved, false);
});

test('runRuntimeAgenticWorkflow replans after terminal activity error', async () => {
  const originalFetch = globalThis.fetch;
  let pollAttempts = 0;
  globalThis.fetch = async () => {
    pollAttempts += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        result: {
          content: [{ type: 'text', text: JSON.stringify({
            _activity: {
              id: 'job-failed',
              source: 'production',
              label: 'Production build',
              status: 'error',
              terminal: true,
              error: 'build failed',
            },
          }) }],
        },
      }),
    };
  };
  const session = {
    mcp: {
      production: {
        status: 'connected',
        url: 'http://127.0.0.1:3000/mcp/',
        retry: { maxAttempts: 1, backoffMs: 0 },
      },
    },
    activities: {},
    headlessPlan: null,
    llm: {
      async completeWithTools({ system }) {
        if (/replanner/.test(system)) return { content: '{"steps":["Retry build"]}' };
        return { content: '{"ok":true,"reason":"Build complete.","suggestedAction":null}' };
      },
    },
  };
  let turns = 0;
  const agent = {
    async invoke({ session: turnSession }) {
      turns += 1;
      if (turns === 1) {
        dispatchAgentEvent(turnSession, createAgentEvent('activity_upserted', {
          payload: {
            activity: {
              id: 'job-failed',
              source: 'production',
              label: 'Production build',
              status: 'running',
              terminal: false,
              poll: { server: 'production', tool: 'production_job_status', args: { jobId: 'job-failed' }, intervalMs: 0 },
            },
          },
        }));
        return { response: 'Started build.' };
      }
      if (turnSession.headlessPlan?.[0]?.status === 'pending') {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_step_updated', {
          origin: 'tool',
          payload: { step: 1, status: 'done' },
        }));
      }
      return { response: 'Retry done.' };
    },
  };

  try {
    const result = await runRuntimeAgenticWorkflow(agent, session, 'Build workspace', {
      runId: 'run-replan-activity',
      timeoutMs: 1000,
      maxTurns: 3,
      maxReplans: 1,
    });

    assert.equal(result.ok, true);
    assert.equal(pollAttempts, 1);
    assert.equal(turns, 2);
    assert.equal(session.agentProjection.replans[0].reason, 'Production build ended with error: build failed');
    assert.deepEqual(session.agentProjection.replans[0].plan, ['Retry build']);
    assert.equal(session.agentProjection.status, 'done');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runRuntimeAgenticWorkflow stops after replan budget is exhausted', async () => {
  const session = {
    activities: {},
    headlessPlan: null,
    llm: {
      async completeWithTools() {
        return { content: '{"ok":false,"reason":"Still missing.","suggestedAction":"Try again."}' };
      },
    },
  };
  const agent = {
    async invoke({ session: turnSession }) {
      if (turnSession.headlessPlan === null) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: { steps: [{ step: 1, id: 'task', description: 'Task', status: 'done' }] },
        }));
      }
      return { response: 'Done.' };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'Do task', {
    runId: 'run-replan-limit',
    timeoutMs: 1000,
    maxTurns: 1,
    maxReplans: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.evaluationRejected, true);
  assert.equal(session.agentProjection.status, 'error');
  assert.equal(session.agentProjection.replans.length, 0);
});

test('runRuntimeParallelPlan dispatches orchestrated tasks without child LLM loops', async () => {
  let llmCalls = 0;
  const executeOrder = [];
  const completed = new Set(['join']);
  const jobs = new Map();
  const session = {
    workspace: 'demo-workspace',
    activities: {},
    mcp: {
      production: {
        status: 'connected',
        tools: [
          { name: 'agent_execute' },
          { name: 'agent_status' },
          { name: 'agent_cancel' },
        ],
      },
    },
    agentRegistrySnapshot: [productionAgent()],
    wikircConfig: { capabilityRouting: {} },
    llm: {
      async completeWithTools() {
        llmCalls += 1;
        return { content: '{"ok":true,"reason":"unused"}' };
      },
    },
    headlessPlan: [
      plannedDoctorTask('a', []),
      plannedDoctorTask('b', []),
      plannedDoctorTask('join', ['a', 'b']),
    ],
  };
  const agent = {
    async invoke() {
      assert.fail('orchestrated task execution must not invoke a child Donna loop');
    },
  };
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
        ...(done ? {
          result: {
            status: 'succeeded',
            outputRefs: [{ type: 'file', ref: `out/${job.taskId}.json` }],
            metrics: { durationMs: 1 },
          },
        } : {}),
      });
    }
    if (toolName === 'agent_cancel') return toolResult({ ok: true });
    throw new Error(`unexpected tool: ${toolName}`);
  };

  const running = runRuntimeParallelPlan(agent, session, 'Run three tasks', {
    runId: 'run-dispatch',
    timeoutMs: 1000,
    maxTurns: 1,
    concurrency: 2,
    callTool,
    dispatcherPollIntervalMs: 1,
  });
  await waitFor(() => executeOrder.includes('a') && executeOrder.includes('b'));
  assert.deepEqual(session.headlessPlan.slice(0, 2).map((step) => step.status), ['running', 'running']);
  completed.add('a');
  completed.add('b');

  const result = await running;

  assert.equal(result.ok, true);
  assert.equal(llmCalls, 0);
  assert.deepEqual(executeOrder, ['a', 'b', 'join']);
  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done', 'done']);
  assert.deepEqual(session.headlessPlan.map((step) => step.outputRefs?.[0]?.ref), ['out/a.json', 'out/b.json', 'out/join.json']);
  assert.deepEqual(
    session.agentEvents
      .filter((event) => ['task.result_returned', 'task.completed'].includes(event.type))
      .map((event) => `${event.type}:${event.taskId}`),
    [
      'task.result_returned:a',
      'task.completed:a',
      'task.result_returned:b',
      'task.completed:b',
      'task.result_returned:join',
      'task.completed:join',
    ],
  );
});

test('runRuntimeParallelPlan fails cleanly when scheduler budget is exceeded', async () => {
  const session = {
    mcp: { tools: {} },
    agentEvents: [],
    headlessPlan: [plannedDoctorTask('a', [])],
  };
  const agent = {
    async invoke() {
      assert.fail('budget rejection must happen before child execution');
    },
  };

  const result = await runRuntimeParallelPlan(agent, session, 'Run one task', {
    runId: 'run-budget',
    timeoutMs: 1000,
    maxTurns: 1,
    budgets: { maxTasks: 0 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.reason, 'max_tasks_exceeded');
  assert.ok(session.agentEvents.some((event) => event.type === 'run_error' && event.payload?.budget?.reason === 'max_tasks_exceeded'));
  assert.equal(session.headlessPlan[0].status, 'pending');
});

test('runRuntimeParallelPlan retries a retryable task on a fallback agent', async () => {
  const executeServers = [];
  const session = {
    mcp: {
      cme: { tools: [{ name: 'agent_execute' }, { name: 'agent_status' }, { name: 'agent_cancel' }] },
      commercial: { tools: [{ name: 'agent_execute' }, { name: 'agent_status' }, { name: 'agent_cancel' }] },
    },
    agentEvents: [],
    headlessPlan: [{
      ...plannedDoctorTask('a', []),
      retryPolicy: {
        maxAttempts: 2,
        retryableErrors: ['temporarily_unavailable'],
        allowAgentFallback: true,
      },
    }],
    capabilityRegistry: fallbackRegistry(),
  };
  const jobs = new Map();
  const callTool = async (_mcp, serverName, toolName, args) => {
    if (toolName === 'agent_execute') {
      executeServers.push(serverName);
      const jobId = `${serverName}-job`;
      jobs.set(jobId, { serverName, taskId: args.taskId });
      return toolResult({ accepted: true, jobId, status: 'queued' });
    }
    if (toolName === 'agent_status') {
      const job = jobs.get(args.jobId);
      if (job.serverName === 'cme') {
        return toolResult({
          jobId: args.jobId,
          taskId: job.taskId,
          status: 'failed',
          result: {
            status: 'failed',
            error: { code: 'temporarily_unavailable', message: 'CME unavailable', retryable: true },
          },
        });
      }
      return toolResult({
        jobId: args.jobId,
        taskId: job.taskId,
        status: 'done',
        result: {
          status: 'succeeded',
          outputRefs: [{ type: 'file', ref: 'out/a.json' }],
          metrics: { durationMs: 1 },
        },
      });
    }
    return toolResult({ ok: true });
  };

  const result = await runRuntimeParallelPlan({ invoke: async () => assert.fail('no child loop') }, session, 'Retry task', {
    runId: 'run-retry-fallback',
    timeoutMs: 1000,
    maxTurns: 1,
    concurrency: 1,
    callTool,
    dispatcherPollIntervalMs: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(executeServers, ['cme', 'commercial']);
  assert.equal(session.headlessPlan[0].status, 'done');
  assert.ok(session.agentEvents.some((event) => event.type === 'task.retry_scheduled'
    && event.payload.previousAgentInstanceId === 'cme-main'
    && event.payload.newAgentInstanceId === 'commercial-main'));
});

function plannedDoctorTask(id, dependsOn) {
  return {
    step: id === 'a' ? 1 : id === 'b' ? 2 : 3,
    id,
    label: `Task ${id}`,
    description: `Task ${id}`,
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

function fallbackRegistry() {
  const providers = [
    fallbackProvider('cme-main', 'cme'),
    fallbackProvider('commercial-main', 'commercial'),
  ];
  return {
    providersFor(capability) {
      return capability === 'workspace.diagnose' ? providers : [];
    },
    isCompatible(contractVersion) {
      return String(contractVersion) === '1';
    },
  };
}

function fallbackProvider(agentInstanceId, serverName) {
  return {
    agentInstanceId,
    serverName,
    health: 'available',
    capability: {
      id: 'workspace.diagnose',
      version: '1',
      description: 'Diagnose',
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: {},
      supportedOperations: ['doctor'],
    },
    description: { contractVersion: '1', limits: { maxTaskDurationMs: 1000 } },
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
      capabilities: [
        {
          id: 'workspace.diagnose',
          version: '1',
          description: 'Diagnose workspace',
          inputSchema: { type: 'object', additionalProperties: true },
          outputSchema: { type: 'object', additionalProperties: true },
          supportedOperations: ['doctor'],
        },
      ],
      orchestration: {
        canPlan: true,
        canExpandPlan: false,
        canExecute: true,
        canCancel: true,
        canResume: false,
        supportsIdempotency: false,
        supportsParallelWorkers: true,
      },
      limits: {
        recommendedConcurrency: 2,
        maxConcurrency: 2,
        maxTaskDurationMs: 1000,
      },
      health: { status: 'available' },
    },
  };
}

function toolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition was not met before timeout');
}
