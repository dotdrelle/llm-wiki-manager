import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { finishRuntimeRun, replanRuntimeRun, runRuntimeAgenticWorkflow, runRuntimeParallelPlan } from './runner.js';

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
    headlessPlan: null,
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
      if (turnSession.headlessPlan?.[0]?.status === 'pending') {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_step_updated', {
          origin: 'tool',
          payload: { step: 1, status: 'done' },
        }));
      }
      return { response: turns === 1 ? 'Initial done.' : 'Export done.' };
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
    async invoke() {
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

test('runRuntimeParallelPlan executes ready tasks concurrently in one parent run', async () => {
  const started = [];
  const release = {};
  const session = {
    activities: {},
    headlessPlan: [
      { step: 1, id: 'a', description: 'Task A', status: 'pending', dependsOn: [] },
      { step: 2, id: 'b', description: 'Task B', status: 'pending', dependsOn: [] },
      { step: 3, id: 'join', description: 'Join', status: 'pending', dependsOn: ['a', 'b'] },
    ],
  };
  const agent = {
    async invoke({ input }) {
      const id = input.match(/Task id: ([^\n]+)/)?.[1];
      started.push(id);
      if (id !== 'join') {
        await new Promise((resolve) => { release[id] = resolve; });
      }
      return { response: `done ${id}` };
    },
  };

  const running = runRuntimeParallelPlan(agent, session, 'Do work', {
    runId: 'run-parallel',
    timeoutMs: 1000,
    maxTurns: 1,
    concurrency: 2,
  });
  await waitFor(() => started.includes('a') && started.includes('b'));
  assert.deepEqual(session.headlessPlan.slice(0, 2).map((step) => step.status), ['running', 'running']);
  release.a();
  release.b();

  const result = await running;

  assert.equal(result.ok, true);
  assert.deepEqual(started, ['a', 'b', 'join']);
  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done', 'done']);
  assert.ok(session.agentEvents.every((event) => event.runId === 'run-parallel'));
  assert.ok(session.agentEvents.some((event) => event.taskId === 'a'));
  assert.ok(session.agentEvents.some((event) => event.taskId === 'b'));
});

test('runRuntimeParallelPlan serializes conflicting write locks', async () => {
  let active = 0;
  let maxActive = 0;
  const session = {
    activities: {},
    headlessPlan: [
      { step: 1, id: 'a', description: 'Write A', status: 'pending', dependsOn: [], locks: ['workspace:write'] },
      { step: 2, id: 'b', description: 'Write B', status: 'pending', dependsOn: [], locks: ['workspace:write'] },
    ],
  };
  const agent = {
    async invoke() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { response: 'done' };
    },
  };

  const result = await runRuntimeParallelPlan(agent, session, 'Write safely', {
    runId: 'run-locks',
    timeoutMs: 1000,
    maxTurns: 1,
    concurrency: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(maxActive, 1);
  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done']);
});

test('runRuntimeParallelPlan keeps independent child running after sibling failure', async () => {
  const releaseB = {};
  const session = {
    activities: {},
    headlessPlan: [
      { step: 1, id: 'a', description: 'Failing branch', status: 'pending', dependsOn: [] },
      { step: 2, id: 'b', description: 'Independent branch', status: 'pending', dependsOn: [] },
      { step: 3, id: 'join', description: 'Converge', status: 'pending', dependsOn: ['a', 'b'] },
    ],
  };
  const agent = {
    async invoke({ input }) {
      const id = input.match(/Task id: ([^\n]+)/)?.[1];
      if (id === 'a') throw new Error('branch failed');
      if (id === 'b') await new Promise((resolve) => { releaseB.resolve = resolve; });
      return { response: `done ${id}` };
    },
  };

  const running = runRuntimeParallelPlan(agent, session, 'Parallel failure', {
    runId: 'run-failure',
    timeoutMs: 1000,
    maxTurns: 1,
    concurrency: 2,
  });
  await waitFor(() => session.headlessPlan.find((step) => step.id === 'a')?.status === 'failed');
  assert.equal(session.headlessPlan.find((step) => step.id === 'b')?.status, 'running');
  releaseB.resolve();

  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_ready_plan_task');
  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['failed', 'done', 'pending']);
});

test('runRuntimeParallelPlan propagates parent cancellation to child tasks', async () => {
  const controller = new AbortController();
  const session = {
    activities: {},
    headlessPlan: [
      { step: 1, id: 'a', description: 'Long task', status: 'pending', dependsOn: [] },
    ],
  };
  const agent = {
    async invoke({ session: childSession, signal }) {
      assert.equal(childSession._abortSignal, signal);
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('cancelled');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
      return { response: 'unreachable' };
    },
  };

  const running = runRuntimeParallelPlan(agent, session, 'Cancel work', {
    runId: 'run-cancel',
    signal: controller.signal,
    timeoutMs: 1000,
    maxTurns: 1,
    concurrency: 1,
  });
  await waitFor(() => session.headlessPlan[0]?.status === 'running');
  controller.abort();

  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(session.headlessPlan[0].status, 'cancelled');
});

test('runRuntimeAgenticWorkflow hands off to the parallel scheduler when turn 1 sets a multi-task ready plan', async () => {
  const session = {
    activities: {},
    headlessPlan: null,
    llm: {
      async completeWithTools() {
        return { content: '{"ok":true,"reason":"Done.","suggestedAction":null}' };
      },
    },
  };
  const started = [];
  const agent = {
    async invoke({ session: turnSession, input }) {
      if (turnSession.headlessPlan === null) {
        dispatchAgentEvent(turnSession, createAgentEvent('plan_set', {
          origin: 'tool',
          payload: {
            steps: [
              { id: 'a', description: 'Task A', dependsOn: [] },
              { id: 'b', description: 'Task B', dependsOn: [] },
            ],
          },
        }));
        return { response: 'Plan set.' };
      }
      const id = input.match(/Task id: ([^\n]+)/)?.[1];
      started.push(id);
      return { response: `done ${id}` };
    },
  };

  const result = await runRuntimeAgenticWorkflow(agent, session, 'Do two independent things', {
    runId: 'run-handoff',
    timeoutMs: 1000,
    maxTurns: 3,
    maxReplans: 0,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(started.sort(), ['a', 'b']);
  assert.deepEqual(session.headlessPlan.map((step) => step.status), ['done', 'done']);
});

test('runRuntimeParallelPlan drains other active tasks before rejecting on cancellation', async () => {
  const controller = new AbortController();
  let bSettled = false;
  const session = {
    activities: {},
    headlessPlan: [
      { step: 1, id: 'a', description: 'Task A', status: 'pending', dependsOn: [] },
      { step: 2, id: 'b', description: 'Task B', status: 'pending', dependsOn: [] },
    ],
  };
  const agent = {
    async invoke({ input, signal }) {
      const id = input.match(/Task id: ([^\n]+)/)?.[1];
      if (id === 'a') {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('cancelled');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }
      if (id === 'b') {
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => { bSettled = true; resolve(); }, 20);
          }, { once: true });
        });
      }
      return { response: `done ${id}` };
    },
  };

  const running = runRuntimeParallelPlan(agent, session, 'Cancel work', {
    runId: 'run-cancel-drain',
    signal: controller.signal,
    timeoutMs: 1000,
    maxTurns: 1,
    concurrency: 2,
  });
  await waitFor(() => session.headlessPlan.every((step) => step.status === 'running'));
  controller.abort();

  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(bSettled, true);
  assert.equal(session.headlessPlan.find((step) => step.id === 'b').status, 'done');
});

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition was not met before timeout');
}
