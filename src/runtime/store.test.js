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
  assert.equal(reopened.getState(replayedSession).eventsCursor, event.id);
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
  assert.equal(store.listRuns()[0].workspace, 'legacy');
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
