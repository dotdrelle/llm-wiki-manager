import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeTracer, formatTraceLine, runtimeTraceMode } from '../../src/runtime/traceLog.js';

const ts = '2026-10-16T08:29:54.105Z';

test('a run error is an ERROR line carrying workspace, run and message', () => {
  const line = formatTraceLine({
    type: 'run_error', ts, workspace: 'juno', runId: '10df62c6-8304-486b',
    payload: { message: 'No agent provides capability agent.curate', kind: 'capability_unavailable' },
  });
  assert.equal(line, `${ts} ERROR [juno] run=10df62c6 run_error No agent provides capability agent.curate (capability_unavailable)`);
});

test('runtime_log lines — never persisted in SQLite — are traced, failures as WARN', () => {
  const line = formatTraceLine({
    type: 'runtime_log', ts, workspace: 'juno',
    payload: { message: 'capability-plan: agent.curate unresolvable (capability_not_found)' },
  });
  assert.match(line, /WARN  \[juno\] runtime_log capability-plan: agent\.curate unresolvable/);
});

test('a failed tool result is an ERROR with its code and message', () => {
  const line = formatTraceLine({
    type: 'tool_call_result', ts, workspace: 'juno',
    payload: { name: 'runtime.run_skill', ok: false, result: JSON.stringify({ ok: false, code: 'skill_not_found', message: 'No skill named "/curate".' }) },
  });
  assert.match(line, /ERROR \[juno\] tool_call_result runtime\.run_skill FAILED — skill_not_found — No skill named/);
});

test('chat connector steps trace duration and failure without printing tool arguments', () => {
  const line = formatTraceLine({
    type: 'chat_step', ts, workspace: 'juno',
    payload: { name: 'web_search_exa', ok: false, durationMs: 30_000, arguments: '{"query":"private query"}' },
  });
  assert.match(line, /ERROR \[juno\] chat_step web_search_exa · 30\.0 s · failed/);
  assert.doesNotMatch(line, /private query/);
});

test('repeated agent registrations print only when health or capabilities change', () => {
  const seen = new Map();
  const event = (status) => ({
    type: 'agent.registered', ts, workspace: 'juno',
    payload: { agent: { agentInstanceId: 'production-main', description: { health: { status }, capabilities: [{ id: 'knowledge.update' }] } } },
  });
  assert.match(formatTraceLine(event('available'), { seen }), /production-main health=available capabilities=\[knowledge\.update\]/);
  assert.equal(formatTraceLine(event('available'), { seen }), null);
  assert.match(formatTraceLine(event('unavailable'), { seen }), /^\S+ WARN /);
});

test('streaming noise is silent, and off disables everything', () => {
  assert.equal(formatTraceLine({ type: 'assistant_delta', ts, payload: { text: 'x' } }), null);
  assert.equal(formatTraceLine({ type: 'runtime_heartbeat', ts, payload: {} }), null);
  assert.equal(formatTraceLine({ type: 'run_done', ts, payload: {} }, { mode: 'off' }), null);
  assert.equal(runtimeTraceMode({ WIKI_MANAGER_RUNTIME_TRACE: 'off' }), 'off');
  assert.equal(runtimeTraceMode({}), 'on');
});

test('verbose appends the compact payload', () => {
  const line = formatTraceLine({ type: 'run_done', ts, runId: 'abc', payload: { runId: 'abc' } }, { mode: 'verbose' });
  assert.match(line, /run_done payload=\{"runId":"abc"\}$/);
});

test('the tracer never throws into event delivery', () => {
  const lines = [];
  const trace = createRuntimeTracer({ env: {}, write: (line) => lines.push(line) });
  trace({ type: 'run_started', ts, workspace: 'juno', runId: 'r1', payload: { input: '/curate' } });
  trace({ type: 'run_started', get payload() { throw new Error('boom'); } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /INFO  \[juno\] run=r1 run_started \/curate/);
});
