import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyAgentProjectionToSession, dispatchAgentEvent, reduceAgentEvents } from '../core/agentEvents.js';
import { managerRuntimeDir } from '../core/env.js';

const NON_PERSISTED_EVENT_TYPES = new Set(['runtime_log']);

const RUN_STATUS_BY_TERMINAL_EVENT = {
  run_done: 'done',
  run_error: 'error',
  run_cancelled: 'cancelled',
};

export function defaultRuntimeStateDir() {
  return process.env.WIKI_MANAGER_STATE_DIR
    ? resolve(process.env.WIKI_MANAGER_STATE_DIR)
    : managerRuntimeDir();
}

export function openRuntimeStore({ stateDir = defaultRuntimeStateDir(), fileName = 'runtime.db' } = {}) {
  const resolvedStateDir = resolve(stateDir);
  mkdirSync(resolvedStateDir, { recursive: true });
  const dbPath = join(resolvedStateDir, fileName);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      run_id TEXT,
      turn_id TEXT,
      origin TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      input TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      workspace TEXT,
      server TEXT NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      lock_key TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      job_id TEXT,
      activity_key TEXT,
      error TEXT,
      created_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  let lastEventId = null;

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (id, ts, type, run_id, turn_id, origin, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listEventsStatement = db.prepare(`
    SELECT id, ts, type, run_id, turn_id, origin, payload
    FROM events
    ORDER BY ts ASC, id ASC
  `);
  const upsertRun = db.prepare(`
    INSERT INTO runs (id, status, input, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      input = COALESCE(excluded.input, runs.input),
      updated_at = excluded.updated_at
  `);
  const listRunsStatement = db.prepare(`
    SELECT id, status, input, created_at, updated_at
    FROM runs
    ORDER BY created_at DESC
  `);
  const upsertQueueItem = db.prepare(`
    INSERT INTO queue_items (
      id, workspace, server, tool, args, lock_key, status, reason, job_id, activity_key,
      error, created_at, started_at, finished_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace = excluded.workspace,
      server = excluded.server,
      tool = excluded.tool,
      args = excluded.args,
      lock_key = excluded.lock_key,
      status = excluded.status,
      reason = excluded.reason,
      job_id = excluded.job_id,
      activity_key = excluded.activity_key,
      error = excluded.error,
      created_at = excluded.created_at,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `);
  const deleteMissingQueueItems = db.prepare(`
    DELETE FROM queue_items
    WHERE id NOT IN (SELECT value FROM json_each(?))
  `);
  const clearQueueItems = db.prepare('DELETE FROM queue_items');
  const listQueueStatement = db.prepare(`
    SELECT id, workspace, server, tool, args, lock_key, status, reason, job_id, activity_key,
      error, created_at, started_at, finished_at, updated_at
    FROM queue_items
    ORDER BY COALESCE(created_at, updated_at) ASC, id ASC
  `);

  function persistEvent(event) {
    if (NON_PERSISTED_EVENT_TYPES.has(event.type)) return event;
    insertEvent.run(
      event.id,
      event.ts,
      event.type,
      event.runId ?? null,
      event.turnId ?? null,
      event.origin ?? null,
      JSON.stringify(event.payload ?? {}),
    );
    lastEventId = event.id;
    if (event.type === 'run_started') {
      persistRun({
        id: event.runId ?? event.payload?.runId ?? event.id,
        status: 'running',
        input: event.payload?.input ?? null,
        createdAt: event.ts,
        updatedAt: event.ts,
      });
    } else if (RUN_STATUS_BY_TERMINAL_EVENT[event.type]) {
      const runId = event.runId ?? event.payload?.runId ?? null;
      if (runId) {
        persistRun({
          id: runId,
          status: RUN_STATUS_BY_TERMINAL_EVENT[event.type],
          updatedAt: event.ts,
        });
      }
    }
    return event;
  }

  function persistRun({ id, status, input = null, createdAt = null, updatedAt = null }) {
    if (!id) return;
    const now = new Date().toISOString();
    upsertRun.run(id, status, input, createdAt ?? now, updatedAt ?? now);
  }

  function listEvents() {
    return listEventsStatement.all().map(rowToEvent);
  }

  function listRuns() {
    return listRunsStatement.all().map((row) => ({
      id: row.id,
      status: row.status,
      input: row.input,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  function saveQueue(queue = []) {
    const items = Array.isArray(queue) ? queue : [];
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      if (items.length === 0) {
        clearQueueItems.run();
      } else {
        deleteMissingQueueItems.run(JSON.stringify(items.map((item) => item.id)));
        for (const item of items) {
          upsertQueueItem.run(
            item.id,
            item.workspace ?? null,
            item.server ?? 'production',
            item.tool ?? 'production_start_job',
            JSON.stringify(item.args ?? {}),
            item.lockKey ?? null,
            item.status ?? 'waiting',
            item.reason ?? null,
            item.jobId ?? null,
            item.activityKey ?? null,
            item.error ?? null,
            item.createdAt ?? now,
            item.startedAt ?? null,
            item.finishedAt ?? null,
            now,
          );
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function listQueue() {
    return listQueueStatement.all().map((row) => ({
      id: row.id,
      workspace: row.workspace ?? null,
      server: row.server,
      tool: row.tool,
      args: row.args ? JSON.parse(row.args) : {},
      lockKey: row.lock_key ?? null,
      status: row.status,
      reason: row.reason ?? null,
      jobId: row.job_id ?? undefined,
      activityKey: row.activity_key ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at ?? undefined,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      updatedAt: row.updated_at,
    }));
  }

  function replayEvents(session) {
    const events = listEvents();
    for (const event of events) {
      dispatchAgentEvent(session, event);
    }
    if (events.length > 0) lastEventId = events.at(-1).id;
    return session.agentProjection ?? reduceAgentEvents([]);
  }

  function getProjection() {
    return reduceAgentEvents(listEvents());
  }

  function getState(session = null) {
    const projection = session?.agentProjection ?? reduceAgentEvents(listEvents());
    const queue = session?.queueStore?.list() ?? listQueue();
    return {
      ...projection,
      runs: listRuns(),
      queue: queue.map((item) => ({ ...item })),
      eventsCursor: lastEventId,
    };
  }

  function hydrateSession(session) {
    const projection = replayEvents(session);
    applyAgentProjectionToSession(session, projection);
    session.jobQueue = listQueue();
    return projection;
  }

  function close() {
    db.close();
  }

  return {
    db,
    dbPath,
    stateDir: resolvedStateDir,
    persistEvent,
    persistRun,
    listEvents,
    listRuns,
    saveQueue,
    listQueue,
    replayEvents,
    hydrateSession,
    getProjection,
    getState,
    close,
  };
}

function rowToEvent(row) {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    origin: row.origin ?? 'system',
    runId: row.run_id ?? null,
    turnId: row.turn_id ?? null,
    payload: row.payload ? JSON.parse(row.payload) : {},
  };
}
