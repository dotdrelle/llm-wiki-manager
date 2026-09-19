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

// (An unknown type used to produce nothing. It now produces one journal line —
// see "an unknown event type is journalled instead of vanishing" below. The
// old assertion pinned the silence that hid a version skew.)

// ── Activity events (lot 2) ──────────────────────────────────────────────────

test('phase and progress events enrich the journal with bounded counters', () => {
  assert.deepEqual(
    mapRuntimeEvent({ type: 'phase_started', phase: 'discover' }),
    [{ type: 'runtime_log', payload: { message: 'phase discover started' } }],
  );
  const [finished] = mapRuntimeEvent({
    type: 'phase_finished', phase: 'discover', ok: true, tools: 7, pages: 4,
  });
  assert.match(finished.payload.message, /phase discover done — 7 tool\(s\), 4 page\(s\) read/);

  const [interrupted] = mapRuntimeEvent({ type: 'phase_finished', phase: 'critique', ok: false });
  assert.match(interrupted.payload.message, /phase critique interrupted/);
});

// A beat proves the run is alive to whoever watches NOW. It still travels — as
// its own non-persisted event, so the run strip can read it — but one journal
// line per beat would bury what actually happened under "still alive".
test('a heartbeat becomes a non-persisted liveness event, not a journal line', () => {
  assert.deepEqual(
    mapRuntimeEvent({ type: 'heartbeat', elapsedMs: 30_000 }),
    [{ type: 'runtime_heartbeat', payload: { elapsedMs: 30_000 } }],
  );
});

test('a finding carries its severity, its author and its path', () => {
  const [entry] = mapRuntimeEvent({
    type: 'finding',
    role: 'critique',
    severity: 'blocking',
    path: 'wiki/concepts/demo/a.md',
    summary: 'cites no source',
  });
  assert.match(
    entry.payload.message,
    /finding \[blocking\] from critique at wiki\/concepts\/demo\/a\.md: cites no source/,
  );
});

test('a degradation is never filtered', () => {
  const [entry] = mapRuntimeEvent({
    type: 'degraded',
    capability: 'role:critique',
    cause: 'model timeout',
    fallback: 'the run continues without this role',
  });
  assert.match(entry.payload.message, /degraded role:critique: model timeout — the run continues/);
});

/*
 The version-skew guard. A newer gateway talking to an older manager used to
 lose EVERY new event here, silently — the adapter ended on `default: return []`.
 The deliberate silences stay silent, but they are now listed by name, so the
 difference between "we chose not to show this" and "we did not recognise it"
 is visible in the journal instead of being the same thing.
*/
test('an unknown event type is journalled instead of vanishing', () => {
  const [entry] = mapRuntimeEvent({ type: 'sub_phase_started', detail: 'x', weight: 2 });
  assert.equal(entry.type, 'runtime_log');
  assert.match(entry.payload.message, /unrecognized runtime event "sub_phase_started"/);
  assert.match(entry.payload.message, /fields: detail, weight/);
});

test('the deliberate silences stay silent', () => {
  for (const type of ['agent_thinking', 'run_started', 'run_completed', 'run_failed', 'run_cancelled']) {
    assert.deepEqual(mapRuntimeEvent({ type }), [], `${type} must stay silent`);
  }
});

test('a memory notice is journalled as maintenance, not as a failure', () => {
  const [entry] = mapRuntimeEvent({
    type: 'notice', topic: 'memory.evicted', detail: 'old-workspace',
  });
  assert.equal(entry.type, 'runtime_log');
  assert.match(entry.payload.message, /^notice memory\.evicted: old-workspace$/);
});

test('the final stream maps as deltas, and a reset clears them', () => {
  assert.deepEqual(
    mapRuntimeEvent({ type: 'assistant_delta', delta: 'Hi' }),
    [{ type: 'assistant_delta', payload: { delta: 'Hi' } }],
  );
  assert.deepEqual(
    mapRuntimeEvent({ type: 'assistant_delta_reset' }),
    [{ type: 'assistant_delta_reset', payload: {} }],
  );
  assert.deepEqual(mapRuntimeEvent({ type: 'assistant_delta', delta: '' }), []);
});
