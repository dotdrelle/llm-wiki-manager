import assert from 'node:assert/strict';
import test from 'node:test';
import { finishRuntimeRun } from './runner.js';

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
