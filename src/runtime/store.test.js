import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { openRuntimeStore } from './store.js';

function runtimeStateDir() {
  return join(mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-')), '.wiki-manager');
}

function plannedTask(id) {
  return {
    id,
    label: 'Build A',
    description: 'Build A',
    requiredCapability: 'document.build',
    operation: 'build',
    arguments: { templates: ['templates/a.md'] },
    dependsOn: [],
    parallelizable: true,
    inputRefs: [],
    expectedOutputRefs: [{ type: 'file', ref: 'deliverables/a.md' }],
    locks: ['deliverable:deliverables/a.md'],
    requiresApproval: false,
    idempotencyKey: 'test-key',
    progressWeight: 1,
    status: 'pending',
  };
}

test('runtime store persists and replays agent events into a projection', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };

  const event = createAgentEvent('plan_set', {
    origin: 'test',
    payload: { steps: [{ description: 'Ingest', status: 'running' }] },
  });
  store.persistEvent(dispatchAgentEvent(session, event));
  assert.equal(store.listEvents().length, 1);
  store.close();

  const reopened = openRuntimeStore({ stateDir });
  const replayedSession = { activities: {}, headlessPlan: null };
  reopened.hydrateSession(replayedSession);
  assert.equal(replayedSession.headlessPlan.length, 1);
  assert.equal(replayedSession.headlessPlan[0].description, 'Ingest');
  assert.equal(reopened.getState(replayedSession).eventsCursor, 1);
  reopened.close();
});

test('runtime store persists agent registry tables and exposes registry in state', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const agent = {
    agentInstanceId: 'production-main',
    health: 'available',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    description: {
      contractVersion: '1',
      agentType: 'production',
      agentInstanceId: 'production-main',
      displayName: 'Production',
      capabilities: [{
        id: 'knowledge.update',
        version: '1',
        description: 'Update wiki knowledge',
        inputSchema: {},
        outputSchema: {},
        supportedOperations: ['ingest'],
        defaultRequiresApproval: true,
      }],
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
        recommendedConcurrency: 1,
        maxConcurrency: 2,
      },
      health: { status: 'available' },
    },
  };

  store.persistEvent(createAgentEvent('agent.registered', {
    origin: 'agent_registry',
    payload: { agent },
  }));

  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agent_capabilities').get().n, 1);
  assert.equal(store.listAgents()[0].agentInstanceId, 'production-main');
  const state = store.getState();
  assert.equal(state.agents[0].agentInstanceId, 'production-main');
  assert.equal(state.capabilityRegistry['knowledge.update@1'][0].agentInstanceId, 'production-main');
  store.close();
});

test('runtime store persists task assignments attempts and results from events', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const runId = 'run-task-persistence';
  const taskId = 'run-task-persistence:build-a';
  const attemptId = 'attempt-1';

  for (const event of [
    createAgentEvent('run_started', {
      origin: 'runtime',
      runId,
      workspace: 'docs',
      payload: { input: 'build docs', workspace: 'docs' },
    }),
    createAgentEvent('task.created', {
      origin: 'plan_integrator',
      runId,
      taskId,
      workspace: 'docs',
      payload: { runId, task: plannedTask(taskId) },
    }),
    createAgentEvent('task.assigned', {
      origin: 'assignment_manager',
      runId,
      taskId,
      workspace: 'docs',
      payload: {
        runId,
        taskId,
        attemptId,
        assignment: {
          attemptId,
          agentInstanceId: 'production-main',
          agentId: 'production',
          poolId: 'production-pool',
        },
      },
    }),
    createAgentEvent('task.started', {
      origin: 'dispatcher',
      runId,
      taskId,
      workspace: 'docs',
      payload: { runId, taskId, attemptId, jobId: 'job-1', startedAt: '2026-07-07T10:00:00.000Z' },
    }),
    createAgentEvent('task.result_returned', {
      origin: 'result_aggregator',
      runId,
      taskId,
      workspace: 'docs',
      payload: {
        runId,
        taskId,
        attemptId,
        result: {
          attemptId,
          taskId,
          jobId: 'job-1',
          status: 'succeeded',
          summary: 'Built A',
          outputRefs: [{ type: 'file', ref: 'deliverables/a.md' }],
          metrics: { durationMs: 42 },
        },
      },
    }),
    createAgentEvent('task.completed', {
      origin: 'result_aggregator',
      runId,
      taskId,
      workspace: 'docs',
      payload: { runId, taskId, attemptId, result: { attemptId, taskId, status: 'succeeded' } },
    }),
    createAgentEvent('task.retry_scheduled', {
      origin: 'attempt_manager',
      runId,
      taskId,
      workspace: 'docs',
      payload: {
        runId,
        taskId,
        attemptId: 'attempt-2',
        reason: 'retryable_error',
        error: { code: 'rate_limit', retryable: true },
      },
    }),
  ]) {
    store.persistEvent(event);
  }

  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_assignments').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_attempts').get().n, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_results').get().n, 1);
  assert.equal(store.listTasks({ runId })[0].id, taskId);
  assert.deepEqual(store.listTaskAssignments({ taskId })[0], {
    taskId,
    attemptId,
    agentInstanceId: 'production-main',
    agentId: 'production',
    poolId: 'production-pool',
    assignedAt: store.listTaskAssignments({ taskId })[0].assignedAt,
  });
  assert.deepEqual(store.listTaskAttempts({ taskId }).map((attempt) => attempt.status), ['done', 'retry_scheduled']);
  assert.deepEqual(store.getTaskResult({ taskId }).outputRefs, [{ type: 'file', ref: 'deliverables/a.md' }]);
  assert.equal(store.getTaskResult({ taskId }).metrics.durationMs, 42);
  store.close();

  const reopened = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };
  reopened.hydrateSession(session, { workspace: 'docs' });
  assert.ok(reopened.getState(session, { workspace: 'docs' }).logs.some((line) => line === `Task assigned: ${taskId}`));
  assert.equal(reopened.listTaskAttempts({ taskId })[0].jobId, 'job-1');
  assert.equal(reopened.getTaskResult({ taskId }).status, 'succeeded');
  reopened.close();
});

test('runtime store writes schema versions to sqlite and meta file', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const stateDir = join(root, '.wiki-manager');
  const store = openRuntimeStore({ stateDir });
  const version = store.db.prepare('PRAGMA user_version').get().user_version;
  const meta = JSON.parse(readFileSync(join(root, '.wiki-manager', 'meta.json'), 'utf8'));

  assert.equal(version, 1);
  assert.equal(meta.schemaVersion, 1);
  assert.equal(existsSync(join(root, '.wiki', 'meta.json')), false);
  store.close();
});

test('runtime store refuses unknown sqlite schema versions', () => {
  const stateDir = runtimeStateDir();
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, 'runtime.db'));
  db.exec('PRAGMA user_version = 99');
  db.close();

  assert.throws(
    () => openRuntimeStore({ stateDir }),
    /Unsupported runtime store schema version 99/,
  );
});

test('runtime store refuses unknown runtime metadata versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const stateDir = join(root, '.wiki-manager');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'meta.json'), '{"schemaVersion":99}\n', 'utf8');

  assert.throws(
    () => openRuntimeStore({ stateDir }),
    /Unsupported runtime metadata schemaVersion 99/,
  );
});

test('runtime store migrates legacy .wiki metadata to .wiki-manager', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const stateDir = join(root, '.wiki-manager');
  mkdirSync(join(root, '.wiki'), { recursive: true });
  writeFileSync(join(root, '.wiki', 'meta.json'), '{"schemaVersion":1,"legacy":true}\n', 'utf8');

  const store = openRuntimeStore({ stateDir });
  const meta = JSON.parse(readFileSync(join(stateDir, 'meta.json'), 'utf8'));

  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.legacy, true);
  assert.equal(existsSync(join(root, '.wiki', 'meta.json')), false);
  store.close();
});

test('runtime store persists duplicate events idempotently', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const event = createAgentEvent('run_started', {
    origin: 'test',
    runId: 'run-1',
    turnId: 'run-1:turn-0',
    workspace: 'acme',
    payload: { input: 'build wiki', workspace: 'acme' },
  });

  store.persistEvent(event);
  store.persistEvent(event);

  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listEvents()[0].sequence, 1);
  assert.equal(store.getState().eventsCursor, 1);
  assert.equal(store.listRuns()[0].id, 'run-1');
  assert.equal(store.listRuns()[0].workspace, 'acme');
  assert.equal(store.listRuns()[0].status, 'running');
  store.close();
});

test('runtime store purges terminal runs older than thirty days on open', () => {
  const stateDir = runtimeStateDir();
  const first = openRuntimeStore({ stateDir });
  for (const runId of ['old-done', 'recent-done', 'old-running']) {
    first.persistEvent(createAgentEvent('run_started', {
      origin: 'test',
      runId,
      turnId: `${runId}:turn-0`,
      workspace: 'docs',
      payload: { input: runId, workspace: 'docs' },
    }));
  }
  first.persistEvent(createAgentEvent('run_done', {
    origin: 'test',
    runId: 'old-done',
    workspace: 'docs',
    payload: { runId: 'old-done', workspace: 'docs' },
  }));
  first.persistEvent(createAgentEvent('assistant_message', {
    origin: 'test',
    runId: 'old-done',
    workspace: 'docs',
    payload: { runId: 'old-done', content: 'old related event' },
  }));
  first.persistEvent(createAgentEvent('run_done', {
    origin: 'test',
    runId: 'recent-done',
    workspace: 'docs',
    payload: { runId: 'recent-done', workspace: 'docs' },
  }));
  first.close();

  const db = new DatabaseSync(join(stateDir, 'runtime.db'));
  db.prepare("UPDATE runs SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id IN ('old-done', 'old-running')").run();
  db.close();

  const reopened = openRuntimeStore({ stateDir });
  assert.deepEqual(reopened.listRuns().map((run) => run.id).sort(), ['old-running', 'recent-done']);
  assert.equal(reopened.listEvents().some((event) => event.runId === 'old-done'), false);
  assert.equal(reopened.listEvents().some((event) => event.runId === 'recent-done'), true);
  assert.equal(reopened.listEvents().some((event) => event.runId === 'old-running'), true);
  reopened.close();
});

test('runtime store persists run identity fields on events', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('assistant_message', {
    origin: 'agent',
    runId: 'run-2',
    turnId: 'run-2:turn-1',
    taskId: 'task-1',
    workspace: 'docs',
    payload: { content: 'done' },
  }));

  const [event] = store.listEvents();
  assert.equal(event.runId, 'run-2');
  assert.equal(event.turnId, 'run-2:turn-1');
  assert.equal(event.taskId, 'task-1');
  assert.equal(event.workspace, 'docs');
  store.close();
});

test('runtime store exposes a correlated audit trail', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('tool_call_started', {
    origin: 'agent',
    runId: 'run-audit',
    turnId: 'run-audit:turn-1',
    taskId: 'task-a',
    workspace: 'docs',
    payload: { callId: 'call-1', name: 'production_start_job' },
  }));
  store.persistEvent(createAgentEvent('activity_upserted', {
    origin: 'tool',
    runId: 'run-audit',
    turnId: 'run-audit:turn-1',
    taskId: 'task-a',
    workspace: 'docs',
    payload: {
      activity: {
        id: 'job-1',
        source: 'production',
        kind: 'job',
        label: 'Production job',
        status: 'running',
        progress: {},
        poll: null,
        outputRefs: [],
      },
    },
  }));

  const audit = store.listAuditTrail({ workspace: 'docs', runId: 'run-audit' });
  assert.equal(audit.length, 2);
  assert.equal(audit[0].toolCallId, 'call-1');
  assert.equal(audit[0].taskId, 'task-a');
  assert.equal(audit[1].activityId, 'job-1');
  assert.equal(audit[1].workspace, 'docs');
  store.close();
});

test('runtime store replays evaluator verdict into state', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'runtime',
    runId: 'run-eval',
    turnId: 'run-eval:turn-0',
    workspace: 'docs',
    payload: { input: 'build docs', workspace: 'docs' },
  }));
  store.persistEvent(createAgentEvent('run_evaluated', {
    origin: 'runtime',
    runId: 'run-eval',
    turnId: 'run-eval:turn-1',
    workspace: 'docs',
    payload: {
      ok: true,
      reason: 'Task complete.',
      suggestedAction: null,
    },
  }));
  store.close();

  const reopened = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };
  reopened.hydrateSession(session, { workspace: 'docs' });

  assert.deepEqual(reopened.getState(session, { workspace: 'docs' }).evaluation, {
    ok: true,
    reason: 'Task complete.',
    suggestedAction: null,
    runId: 'run-eval',
  });
  reopened.close();
});

test('runtime store replays replan trace into state', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'runtime',
    runId: 'run-replan',
    turnId: 'run-replan:turn-0',
    workspace: 'docs',
    payload: { input: 'build docs', workspace: 'docs' },
  }));
  store.persistEvent(createAgentEvent('run_replanned', {
    origin: 'runtime',
    runId: 'run-replan',
    turnId: 'run-replan:turn-1',
    workspace: 'docs',
    payload: {
      reason: 'Build failed.',
      plan: ['Retry build'],
      replansLeft: 1,
    },
  }));
  store.close();

  const reopened = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };
  reopened.hydrateSession(session, { workspace: 'docs' });

  assert.deepEqual(reopened.getState(session, { workspace: 'docs' }).replans, [{
    reason: 'Build failed.',
    plan: ['Retry build'],
    replansLeft: 1,
    runId: 'run-replan',
  }]);
  reopened.close();
});

test('runtime store tracks pending approval run status', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'runtime',
    runId: 'run-approval',
    workspace: 'docs',
    payload: { input: 'build docs', workspace: 'docs' },
  }));
  store.persistEvent(createAgentEvent('run_pending_approval', {
    origin: 'runtime',
    runId: 'run-approval',
    workspace: 'docs',
    payload: { approvalId: 'approval-1', runId: 'run-approval', plan: ['Build'] },
  }));

  assert.equal(store.listRuns({ workspace: 'docs' })[0].status, 'pending_approval');

  store.persistEvent(createAgentEvent('run_approved', {
    origin: 'runtime',
    runId: 'run-approval',
    workspace: 'docs',
    payload: { approvalId: 'approval-1', runId: 'run-approval' },
  }));

  assert.equal(store.listRuns({ workspace: 'docs' })[0].status, 'running');
  assert.equal(store.getState(null, { workspace: 'docs' }).approvals[0].status, 'approved');
  store.close();
});

test('runtime store persists bounded approval grants', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('approval.granted', {
    origin: 'runtime',
    runId: 'run-approval-grant',
    workspace: 'docs',
    payload: {
      id: 'grant-1',
      scope: 'run',
      runId: 'run-approval-grant',
      workspaceId: 'docs',
      planRevision: 3,
      approvalClasses: ['workspace-write'],
      reason: 'valide tout',
    },
  }));

  const grants = store.listApprovalGrants({ runId: 'run-approval-grant' });
  assert.deepEqual(grants, [{
    id: 'grant-1',
    runId: 'run-approval-grant',
    workspaceId: 'docs',
    planRevision: 3,
    scope: 'run',
    taskId: null,
    groupId: null,
    approvalClasses: ['workspace-write'],
    status: 'approved',
    reason: 'valide tout',
    createdAt: grants[0].createdAt,
    grantedAt: grants[0].grantedAt,
    rejectedAt: null,
  }]);
  store.close();
});

test('runtime store orders events by durable sequence', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const ts = '2026-01-01T00:00:00.000Z';

  store.persistEvent({
    id: 'event-b',
    ts,
    type: 'user_message',
    origin: 'test',
    runId: 'run-seq',
    turnId: 'run-seq:turn-0',
    workspace: 'docs',
    payload: { content: 'first' },
  });
  store.persistEvent({
    id: 'event-a',
    ts,
    type: 'assistant_message',
    origin: 'test',
    runId: 'run-seq',
    turnId: 'run-seq:turn-1',
    workspace: 'docs',
    payload: { content: 'second' },
  });
  store.persistEvent({
    id: 'event-c',
    ts,
    type: 'assistant_message',
    origin: 'test',
    runId: 'run-other',
    turnId: 'run-other:turn-1',
    workspace: 'other',
    payload: { content: 'third' },
  });

  const events = store.listEvents({ workspace: 'docs' });
  assert.deepEqual(events.map((event) => event.id), ['event-b', 'event-a']);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal(store.getState(null, { workspace: 'docs' }).eventsCursor, 2);
  store.close();
});

test('runtime store persists cancelled run status', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'test',
    runId: 'run-1',
    turnId: 'run-1:turn-0',
    workspace: 'acme',
    payload: { input: 'build wiki', workspace: 'acme' },
  }));
  store.persistEvent(createAgentEvent('run_cancelled', {
    origin: 'test',
    runId: 'run-1',
    turnId: 'run-1:turn-1',
    workspace: 'acme',
    payload: { runId: 'run-1', workspace: 'acme' },
  }));

  assert.equal(store.listRuns()[0].status, 'cancelled');
  assert.equal(store.listRuns()[0].workspace, 'acme');
  store.close();
});

test('runtime store migrates legacy databases without workspace columns', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const db = new DatabaseSync(join(stateDir, 'runtime.db'));
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      run_id TEXT,
      turn_id TEXT,
      origin TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      input TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.close();

  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'test',
    runId: 'run-legacy',
    turnId: 'run-legacy:turn-0',
    workspace: 'legacy',
    payload: { input: 'migrate', workspace: 'legacy' },
  }));

  assert.equal(store.listEvents()[0].workspace, 'legacy');
  assert.equal(store.listEvents()[0].sequence, 1);
  assert.equal(store.listRuns()[0].workspace, 'legacy');
  store.close();
});

test('runtime store backfills sequence for legacy event rows', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const db = new DatabaseSync(join(stateDir, 'runtime.db'));
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      run_id TEXT,
      turn_id TEXT,
      workspace TEXT,
      origin TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace TEXT,
      status TEXT NOT NULL,
      input TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO events (id, ts, type, run_id, turn_id, workspace, origin, payload)
    VALUES
      ('legacy-b', '2026-01-01T00:00:00.000Z', 'user_message', 'run-legacy', 'run-legacy:turn-0', 'docs', 'test', '{"content":"first"}'),
      ('legacy-a', '2026-01-01T00:00:00.000Z', 'assistant_message', 'run-legacy', 'run-legacy:turn-1', 'docs', 'test', '{"content":"second"}');
  `);
  db.close();

  const store = openRuntimeStore({ stateDir });
  const events = store.listEvents({ workspace: 'docs' });

  assert.deepEqual(events.map((event) => event.id), ['legacy-b', 'legacy-a']);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  store.close();
});

test('runtime store does not persist runtime logs', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('runtime_log', {
    origin: 'runtime',
    payload: { message: 'agentic-loop: turn 1/20' },
  }));

  assert.equal(store.listEvents().length, 0);
  store.close();
});

test('runtime store persists and hydrates queue items', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.saveQueue([{
    id: 'q-1',
    workspace: 'docs',
    server: 'production',
    tool: 'production_start_job',
    args: { type: 'build', steps: ['ingest'] },
    lockKey: 'production:docs',
    status: 'waiting',
    reason: 'workspace_busy',
    createdAt: '2026-01-01T00:00:00.000Z',
  }]);
  store.close();

  const reopened = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };
  reopened.hydrateSession(session);
  assert.equal(session.jobQueue.length, 1);
  assert.equal(session.jobQueue[0].id, 'q-1');
  assert.equal(session.jobQueue[0].args.type, 'build');
  assert.equal(reopened.getState(session).queue[0].workspace, 'docs');
  reopened.close();
});

test('runtime store filters events runs and queue by workspace', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'test',
    runId: 'run-acme',
    turnId: 'run-acme:turn-0',
    workspace: 'acme',
    payload: { input: 'acme', workspace: 'acme' },
  }));
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'test',
    runId: 'run-docs',
    turnId: 'run-docs:turn-0',
    workspace: 'docs',
    payload: { input: 'docs', workspace: 'docs' },
  }));
  store.saveQueue([{ id: 'q-acme', workspace: 'acme', status: 'waiting' }], { workspace: 'acme' });
  store.saveQueue([{ id: 'q-docs', workspace: 'docs', status: 'waiting' }], { workspace: 'docs' });

  assert.deepEqual(store.listEvents({ workspace: 'acme' }).map((event) => event.runId), ['run-acme']);
  assert.deepEqual(store.listRuns({ workspace: 'docs' }).map((run) => run.id), ['run-docs']);
  assert.deepEqual(store.listQueue({ workspace: 'acme' }).map((item) => item.id), ['q-acme']);

  const session = { activities: {}, headlessPlan: null };
  store.hydrateSession(session, { workspace: 'docs' });
  assert.equal(session.jobQueue[0].id, 'q-docs');
  assert.deepEqual(store.getState(session, { workspace: 'docs' }).runs.map((run) => run.id), ['run-docs']);
  store.close();
});

test('runtime state exposes queue as blocked jobs and pending plan steps', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };

  store.persistEvent(dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'tool',
    workspace: 'docs',
    payload: {
      steps: [
        { step: 1, description: 'Analyze', status: 'done' },
        { step: 2, description: 'Build', status: 'pending' },
        { step: 3, description: 'Verify', status: 'pending' },
      ],
    },
  })));
  store.saveQueue([
    { id: 'q-wait', workspace: 'docs', status: 'waiting', args: { type: 'blocked' } },
    { id: 'q-run', workspace: 'docs', status: 'running', args: { type: 'active' } },
    { id: 'q-done', workspace: 'docs', status: 'done', args: { type: 'done' } },
  ], { workspace: 'docs' });

  const state = store.getState(session, { workspace: 'docs' });
  const queue = state.queue;
  assert.deepEqual(queue.map((item) => item.id), ['q-wait', 'plan-2', 'plan-3']);
  assert.equal(queue[0].queueType, 'blocked_job');
  assert.equal(queue[1].queueType, 'pending_step');
  assert.equal(queue[1].args.type, 'Build');
  assert.ok(state.workflow.nodes.some((node) => node.id === 'task:2'));
  assert.ok(state.workflow.nodes.some((node) => node.id === 'queue:q-wait'));
  assert.ok(state.workflow.waitingReasons.includes('queue:q-wait'));
  store.close();
});

test('runtime store persists and replays control queue events without mixing MCP queue', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('control_enqueued', {
    origin: 'runtime',
    workspace: 'docs',
    payload: { id: 'control-docs', workspace: 'docs', input: 'later' },
  }));
  store.persistEvent(createAgentEvent('control_enqueued', {
    origin: 'runtime',
    workspace: 'acme',
    payload: { id: 'control-acme', workspace: 'acme', input: 'other' },
  }));
  store.close();

  const reopened = openRuntimeStore({ stateDir });
  const session = { activities: {}, headlessPlan: null };
  reopened.hydrateSession(session, { workspace: 'docs' });
  const state = reopened.getState(session, { workspace: 'docs' });
  assert.deepEqual(state.controlQueue.map((item) => item.id), ['control-docs']);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(session.controlQueue.map((item) => item.id), ['control-docs']);
  reopened.close();
});

test('runtime store replays a parallel run into a deterministic workflow projection', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const events = [
    createAgentEvent('run_started', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      workspace: 'docs',
      payload: { input: 'parallel build', workspace: 'docs' },
    }),
    createAgentEvent('plan_set', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      workspace: 'docs',
      payload: {
        steps: [
          { step: 1, id: 'a', description: 'Task A', status: 'pending', dependsOn: [] },
          { step: 2, id: 'b', description: 'Task B', status: 'pending', dependsOn: [] },
          { step: 3, id: 'join', description: 'Join', status: 'pending', dependsOn: ['a', 'b'] },
        ],
      },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      taskId: 'a',
      workspace: 'docs',
      payload: { taskId: 'a', status: 'running' },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      taskId: 'b',
      workspace: 'docs',
      payload: { taskId: 'b', status: 'running' },
    }),
    createAgentEvent('activity_upserted', {
      origin: 'tool',
      runId: 'run-parallel-replay',
      taskId: 'a',
      workspace: 'docs',
      payload: {
        activity: {
          id: 'job-a',
          source: 'production',
          label: 'Task A job',
          status: 'done',
          terminal: true,
          startedAt: '2026-07-04T10:00:00.000Z',
          updatedAt: '2026-07-04T10:00:01.000Z',
          progress: {},
          outputRefs: ['deliverables/a.md'],
        },
      },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      taskId: 'a',
      workspace: 'docs',
      payload: { taskId: 'a', status: 'done' },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      taskId: 'b',
      workspace: 'docs',
      payload: { taskId: 'b', status: 'done' },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      taskId: 'join',
      workspace: 'docs',
      payload: { taskId: 'join', status: 'running' },
    }),
    createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      taskId: 'join',
      workspace: 'docs',
      payload: { taskId: 'join', status: 'done' },
    }),
    createAgentEvent('run_done', {
      origin: 'runtime',
      runId: 'run-parallel-replay',
      workspace: 'docs',
      payload: { runId: 'run-parallel-replay' },
    }),
  ];
  for (const event of events) store.persistEvent(event);
  store.close();

  const first = openRuntimeStore({ stateDir });
  const firstSession = { activities: {}, headlessPlan: null };
  first.hydrateSession(firstSession, { workspace: 'docs' });
  const firstWorkflow = first.getState(firstSession, { workspace: 'docs' }).workflow;
  first.close();

  const second = openRuntimeStore({ stateDir });
  const secondSession = { activities: {}, headlessPlan: null };
  second.hydrateSession(secondSession, { workspace: 'docs' });
  const secondWorkflow = second.getState(secondSession, { workspace: 'docs' }).workflow;

  assert.deepEqual(secondWorkflow, firstWorkflow);
  assert.deepEqual(secondWorkflow.relations.filter((relation) => relation.type === 'depends_on'), [
    { type: 'depends_on', from: 'task:join', to: 'task:a' },
    { type: 'depends_on', from: 'task:join', to: 'task:b' },
  ]);
  second.close();
});

test('runtime store identifies recoverable workspaces and interrupts stale runs', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistRun({
    id: 'run-acme',
    workspace: 'acme',
    status: 'running',
    input: 'build acme',
  });
  store.persistRun({
    id: 'run-done',
    workspace: 'docs',
    status: 'done',
    input: 'done',
  });
  store.saveQueue([{ id: 'q-docs', workspace: 'docs', status: 'waiting' }], { workspace: 'docs' });

  assert.deepEqual(store.listRecoverableWorkspaces(), ['acme', 'docs']);
  assert.deepEqual(store.listRecoverableRuns({ workspace: 'acme' }).map((run) => run.id), ['run-acme']);
  assert.equal(store.interruptRuns({ workspace: 'acme' }), 1);
  assert.equal(store.listRuns({ workspace: 'acme' })[0].status, 'interrupted');
  store.close();
});
