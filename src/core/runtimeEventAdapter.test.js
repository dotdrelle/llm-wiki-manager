import assert from 'node:assert/strict';
import test from 'node:test';
import { mapRuntimeEvent } from './runtimeEventAdapter.js';

test('message becomes an assistant_message', () => {
  const mapped = mapRuntimeEvent({ type: 'message', content: 'analysis complete' });
  assert.deepEqual(mapped, [{ type: 'assistant_message', payload: { content: 'analysis complete' } }]);
});

test('an empty message produces nothing', () => {
  assert.deepEqual(mapRuntimeEvent({ type: 'message', content: '  ' }), []);
});

test('tool_started and tool_finished become structured log lines', () => {
  const started = mapRuntimeEvent({ type: 'tool_started', tool: 'wiki_search' });
  assert.equal(started.length, 1);
  assert.equal(started[0].type, 'runtime_log');
  assert.match(started[0].payload.message, /wiki_search started/);

  const finished = mapRuntimeEvent({ type: 'tool_finished', tool: 'wiki_search', durationMs: 842, resultSummary: '17 documents found' });
  assert.match(finished[0].payload.message, /wiki_search done \(842ms\) — 17 documents found/);
});

test('a failed tool is reported as such, not as a success', () => {
  const mapped = mapRuntimeEvent({ type: 'tool_finished', tool: 'wiki_read', error: 'permission denied' });
  assert.match(mapped[0].payload.message, /wiki_read failed: permission denied/);
});

test('subagent events become first-class timeline events, not log lines', () => {
  assert.deepEqual(mapRuntimeEvent({ type: 'subagent_started', subagent: 'scout' }), [
    { type: 'subagent_started', payload: { subagent: 'scout' } },
  ]);
  assert.deepEqual(mapRuntimeEvent({ type: 'subagent_finished', subagent: 'scout' }), [
    { type: 'subagent_finished', payload: { subagent: 'scout' } },
  ]);
});

test('approval_required becomes an approval.requested with the proposal classes', () => {
  const mapped = mapRuntimeEvent({
    type: 'approval_required',
    approvalId: 'prop-1',
    reason: 'analysis complete',
    proposal: {
      summary: 'analyse',
      mutations: [{ kind: 'send_email' }, { kind: 'plan_expansion' }],
    },
  });

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].type, 'approval.requested');
  assert.equal(mapped[0].payload.approvalId, 'prop-1');
  assert.equal(mapped[0].payload.scope, 'run');
  assert.deepEqual(mapped[0].payload.approvalClasses, ['send_email', 'plan_expansion']);
});

test('private reasoning and terminal events are never re-emitted', () => {
  assert.deepEqual(mapRuntimeEvent({ type: 'agent_thinking', content: 'secret chain of thought' }), []);
  assert.deepEqual(mapRuntimeEvent({ type: 'run_started' }), []);
  assert.deepEqual(mapRuntimeEvent({ type: 'run_completed' }), []);
  assert.deepEqual(mapRuntimeEvent({ type: 'run_failed' }), []);
  assert.deepEqual(mapRuntimeEvent({ type: 'run_cancelled' }), []);
});

test('an unknown event type produces nothing', () => {
  assert.deepEqual(mapRuntimeEvent({ type: 'made_up' }), []);
});
