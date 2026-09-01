import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';
import { compactRuntimeLogForDisplay, formatRuntimeLogPayload, isDispatchPlumbingLine, shortLogId } from './runtimeLog.js';
import { emitRuntimeLog } from '../runtime/supervisor.js';

const CYCLE_EVENTS = [
  'task.ready',
  'capability.resolving',
  'agent.selected',
  'task.assigned',
  'attempt.created',
  'lock.acquired',
  'agent_execute',
  'job.accepted',
  'agent_status',
  'task.result_returned',
  'lock.released',
  'task.completed',
];

function payload(event) {
  return {
    event,
    runId: 'run-123',
    planRevision: 4,
    groupId: 'group-build',
    taskId: 'task-build',
    attemptId: 'attempt-1',
    agentType: 'production',
    agentInstanceId: 'production-main',
    agentId: 'worker-02',
    jobId: 'job-789',
    workspaceId: 'docs',
    capability: 'document.build',
    operation: 'build',
    detail: 'cycle detail',
  };
}

test('formatRuntimeLogPayload renders dispatch plumbing as a compact sentence, business events keep their fields', () => {
  // Dispatch plumbing: who · what · task · job — no run/plan/group/attempt
  // soup. Business events (capability.resolving, agent.selected,
  // task.assigned) keep the full field=value form: those fields ARE the
  // content.
  for (const event of CYCLE_EVENTS) {
    const line = formatRuntimeLogPayload(payload(event), '2026-07-08T14:42:18.000Z');
    if (['capability.resolving', 'agent.selected', 'task.assigned'].includes(event)) {
      assert.match(line, /run=run-123/);
      assert.match(line, /workspace=docs/);
      assert.match(line, /capability=document\.build/);
      assert.match(line, /operation=build/);
      continue;
    }
    assert.match(line, /^14:42:18 · [A-Z_]+ · /);
    assert.match(line, /production-main/);
    assert.match(line, /document\.build\/build/);
    assert.match(line, /task-build/);
    assert.match(line, /job-789/);
    assert.match(line, /cycle detail/);
    assert.doesNotMatch(line, /run=|plan=|group=|attempt=|agentType=|agent=|workspace=|capability=|operation=/);
  }
});

test('emitRuntimeLog accepts structured payloads and preserves legacy strings', () => {
  const session = {
    workspace: 'docs',
    planRevision: 2,
    _currentRunIdentity: { runId: 'run-structured', workspace: 'docs' },
  };
  emitRuntimeLog(session, {
    event: 'task.assigned',
    taskId: 'task-a',
    attemptId: 'attempt-a',
    capability: 'knowledge.update',
    operation: 'ingest',
    detail: 'assigned',
  });
  dispatchAgentEvent(session, createAgentEvent('runtime_log', {
    origin: 'test',
    payload: { message: 'legacy line' },
  }));

  assert.match(session.agentProjection.logs[0], /ASSIGNED/);
  assert.match(session.agentProjection.logs[0], /run=run-structured/);
  assert.match(session.agentProjection.logs[0], /workspace=docs/);
  // Legacy plain messages now carry the same HH:MM:SS prefix as structured
  // events so the Logs/Trace panel stays chronologically readable.
  assert.match(session.agentProjection.logs[1], /^\d{2}:\d{2}:\d{2} legacy line$/);
});

test('vector fallback warnings keep only their reason and message for display', () => {
  const displayed = compactRuntimeLogForDisplay(`09:25:34 trace: WARN retrieval:vector-fallback
    reason=vector-error indexPath=/workspace/.wiki/vector-index queryPreview="a long query" fallback=lexical
    consecutiveErrors=1 disabled=false message="Vector index is missing."`);

  assert.equal(displayed, '09:25:34 trace: WARN retrieval:vector-fallback reason=vector-error message="Vector index is missing."');
  assert.doesNotMatch(displayed, /indexPath|queryPreview|fallback=|consecutiveErrors|disabled=/);
});

test('runtime display compaction leaves other log entries unchanged', () => {
  const line = '09:25:35 trace: ERROR retrieval failed message="broken"';
  assert.equal(compactRuntimeLogForDisplay(line), line);
});

test('long UUIDs collapse to a short prefix so log lines stay on one line', () => {
  const uuid = '7fadad27-0be6-4d08-96e5-664fe7ee841e';
  const line = formatRuntimeLogPayload({
    event: 'task.ready',
    runId: uuid,
    taskId: `${uuid}:taxonomy-synthesis`,
    attemptId: `attempt-${uuid}`,
    agentInstanceId: `production-${uuid}`,
    capability: 'document.build',
    operation: 'build',
  }, '2026-07-08T14:42:18.000Z');

  assert.match(line, /production-7fadad27…/);
  // The taskId's UUID prefix and hash suffix are dropped entirely: the line
  // names the work ("taxonomy synthesis"), not an opaque id.
  assert.match(line, /taxonomy synthesis/);
  assert.doesNotMatch(line, /7fadad27-0be6-4d08-96e5-664fe7ee841e/);
});

test('isDispatchPlumbingLine recognises every formatted event token, dotted ones included', () => {
  // eventLabel() keeps only the last dotted segment, so these are the tokens
  // that actually reach the panel — an event-name enumeration missed them.
  for (const event of ['job.accepted', 'agent.selected', 'capability.resolving', 'runtime.accepted', 'agent_status', 'agent_execute', 'task.result_returned']) {
    const line = formatRuntimeLogPayload({ event, runId: 'r1', taskId: 't1' }, '2026-07-08T14:42:18.000Z');
    assert.equal(isDispatchPlumbingLine(line), true, `expected plumbing: ${line}`);
  }
});

test('isDispatchPlumbingLine leaves the business flow lines for the Runtime tab', () => {
  for (const line of [
    '14:42:18 ▸ Polish proposition — started  (knowledge.polish  → agent-production)',
    '14:42:19 ✓ Polish proposition — done (1 output)',
    '14:42:19 ✗ Ingest DSI — failed: dependency_failed',
    '14:42:20 ↻ Build overview — retry 2/3 (rate_limit)',
    '14:42:21 Run failed: No agent provides capability workspace.restore.',
    '14:42:22 Plan validated for run r1',
    '14:42:23 Control message: où en est le build ?',
  ]) {
    assert.equal(isDispatchPlumbingLine(line), false, `expected business flow: ${line}`);
  }
});

test('isDispatchPlumbingLine recognises the shell-tagged "runtime " lines for the Agent status tab', () => {
  // The Shell prepends "runtime " to every runtime line (useSession
  // visibleLogs): AGENT_STATUS rows must still classify as plumbing, or they
  // end up in the Runtime tab instead of Agent status.
  const tagged = `runtime ${formatRuntimeLogPayload({ event: 'agent_status', runId: 'r1', taskId: 't1' }, '2026-07-08T14:42:18.000Z')}`;
  assert.equal(isDispatchPlumbingLine(tagged), true, 'a tagged AGENT_STATUS line is dispatch plumbing');
  assert.equal(isDispatchPlumbingLine('runtime 14:42:21 Run failed: No agent provides capability workspace.restore.'), false);
  assert.equal(isDispatchPlumbingLine('runtime 14:42:22 Plan validated for run r1'), false);
});

test('shortLogId caps an over-long task slug while shortening embedded UUIDs', () => {
  const long = `${'x'.repeat(48)}-deadbeef`;
  assert.match(shortLogId(long), /…$/);
  assert.ok(shortLogId(long).length <= 40);
  assert.equal(shortLogId('7fadad27-0be6-4d08-96e5-664fe7ee841e'), '7fadad27…');
});
