import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';
import { formatRuntimeLogPayload } from './runtimeLog.js';
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
  assert.equal(session.agentProjection.logs[1], 'legacy line');
});
