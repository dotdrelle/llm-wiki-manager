import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { openRuntimeStore } from './store.js';

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

test('runtime store persists duplicate events idempotently', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  const event = createAgentEvent('run_started', {
    origin: 'test',
    runId: 'run-1',
    turnId: 'run-1:turn-0',
    workspace: 'juno',
    payload: { input: 'build wiki', workspace: 'juno' },
  });

  store.persistEvent(event);
  store.persistEvent(event);

  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listEvents()[0].sequence, 1);
  assert.equal(store.getState().eventsCursor, 1);
  assert.equal(store.listRuns()[0].id, 'run-1');
  assert.equal(store.listRuns()[0].workspace, 'juno');
  assert.equal(store.listRuns()[0].status, 'running');
  store.close();
});

test('runtime store persists run identity fields on events', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistEvent(createAgentEvent('assistant_message', {
    origin: 'agent',
    runId: 'run-2',
    turnId: 'run-2:turn-1',
    workspace: 'docs',
    payload: { content: 'done' },
  }));

  const [event] = store.listEvents();
  assert.equal(event.runId, 'run-2');
  assert.equal(event.turnId, 'run-2:turn-1');
  assert.equal(event.workspace, 'docs');
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
    workspace: 'juno',
    payload: { input: 'build wiki', workspace: 'juno' },
  }));
  store.persistEvent(createAgentEvent('run_cancelled', {
    origin: 'test',
    runId: 'run-1',
    turnId: 'run-1:turn-1',
    workspace: 'juno',
    payload: { runId: 'run-1', workspace: 'juno' },
  }));

  assert.equal(store.listRuns()[0].status, 'cancelled');
  assert.equal(store.listRuns()[0].workspace, 'juno');
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
    runId: 'run-juno',
    turnId: 'run-juno:turn-0',
    workspace: 'juno',
    payload: { input: 'juno', workspace: 'juno' },
  }));
  store.persistEvent(createAgentEvent('run_started', {
    origin: 'test',
    runId: 'run-docs',
    turnId: 'run-docs:turn-0',
    workspace: 'docs',
    payload: { input: 'docs', workspace: 'docs' },
  }));
  store.saveQueue([{ id: 'q-juno', workspace: 'juno', status: 'waiting' }], { workspace: 'juno' });
  store.saveQueue([{ id: 'q-docs', workspace: 'docs', status: 'waiting' }], { workspace: 'docs' });

  assert.deepEqual(store.listEvents({ workspace: 'juno' }).map((event) => event.runId), ['run-juno']);
  assert.deepEqual(store.listRuns({ workspace: 'docs' }).map((run) => run.id), ['run-docs']);
  assert.deepEqual(store.listQueue({ workspace: 'juno' }).map((item) => item.id), ['q-juno']);

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

  const queue = store.getState(session, { workspace: 'docs' }).queue;
  assert.deepEqual(queue.map((item) => item.id), ['q-wait', 'plan-2', 'plan-3']);
  assert.equal(queue[0].queueType, 'blocked_job');
  assert.equal(queue[1].queueType, 'pending_step');
  assert.equal(queue[1].args.type, 'Build');
  store.close();
});

test('runtime store identifies recoverable workspaces and interrupts stale runs', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-manager-runtime-'));
  const store = openRuntimeStore({ stateDir });
  store.persistRun({
    id: 'run-juno',
    workspace: 'juno',
    status: 'running',
    input: 'build juno',
  });
  store.persistRun({
    id: 'run-done',
    workspace: 'docs',
    status: 'done',
    input: 'done',
  });
  store.saveQueue([{ id: 'q-docs', workspace: 'docs', status: 'waiting' }], { workspace: 'docs' });

  assert.deepEqual(store.listRecoverableWorkspaces(), ['docs', 'juno']);
  assert.deepEqual(store.listRecoverableRuns({ workspace: 'juno' }).map((run) => run.id), ['run-juno']);
  assert.equal(store.interruptRuns({ workspace: 'juno' }), 1);
  assert.equal(store.listRuns({ workspace: 'juno' })[0].status, 'interrupted');
  store.close();
});
