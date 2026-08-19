import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';
import { compactRuntimeLogForDisplay, formatRuntimeLogPayload, shortLogId } from './runtimeLog.js';
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

test('formatRuntimeLogPayload formats every dispatcher cycle event with required ids', () => {
  for (const event of CYCLE_EVENTS) {
    const line = formatRuntimeLogPayload(payload(event), '2026-07-08T14:42:18.000Z');
    assert.match(line, /^14:42:18 [A-Z_]+ /);
    assert.match(line, /run=run-123/);
    assert.match(line, /plan=4/);
    assert.match(line, /group=group-build/);
    assert.match(line, /task=task-build/);
    assert.match(line, /attempt=attempt-1/);
    assert.match(line, /agentType=production/);
    assert.match(line, /agentInstance=production-main/);
    assert.match(line, /agent=worker-02/);
    assert.match(line, /job=job-789/);
    assert.match(line, /workspace=docs/);
    assert.match(line, /capability=document\.build/);
    assert.match(line, /operation=build/);
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

  assert.match(line, /run=7fadad27…/);
  assert.match(line, /task=7fadad27…:taxonomy-synthesis/);
  assert.match(line, /attempt=attempt-7fadad27…/);
  assert.match(line, /agentInstance=production-7fadad27…/);
  assert.doesNotMatch(line, /7fadad27-0be6-4d08-96e5-664fe7ee841e/);
});

test('shortLogId caps an over-long task slug while shortening embedded UUIDs', () => {
  const long = `${'x'.repeat(48)}-deadbeef`;
  assert.match(shortLogId(long), /…$/);
  assert.ok(shortLogId(long).length <= 40);
  assert.equal(shortLogId('7fadad27-0be6-4d08-96e5-664fe7ee841e'), '7fadad27…');
});
