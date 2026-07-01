import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { finishRuntimeRun, runRuntimeAgenticWorkflow } from './runner.js';

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
