import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyAgentProjectionToSession, dispatchAgentEvent, reduceAgentEvents } from '../core/agentEvents.js';
import { defaultRuntimeStateDir } from '../core/env.js';
import { projectQueue } from '../core/jobQueue.js';
import { projectWorkflow } from '../core/workflow.js';
import { createCapabilityRegistry } from '../orchestrator/capabilityRegistry.js';

export { defaultRuntimeStateDir };

const NON_PERSISTED_EVENT_TYPES = new Set(['runtime_log']);
export const RUNTIME_STORE_SCHEMA_VERSION = 1;
const RUNTIME_RETENTION_DAYS = 30;
const TERMINAL_RUN_STATUSES = ['done', 'error', 'cancelled', 'interrupted'];

const RUN_STATUS_BY_EVENT = {
  run_done: 'done',
  run_error: 'error',
  run_cancelled: 'cancelled',
  run_pending_approval: 'pending_approval',
  run_approved: 'running',
};

const RECOVERABLE_RUN_STATUSES = ['running', 'waiting', 'pending_approval'];
export const RECOVERABLE_QUEUE_STATUSES = ['waiting', 'queued', 'starting', 'running', 'blocked', 'pending_approval'];

export function openRuntimeStore({ stateDir = defaultRuntimeStateDir(), fileName = 'runtime.db', metaPath = null } = {}) {
  const resolvedStateDir = resolve(stateDir);
  mkdirSync(resolvedStateDir, { recursive: true });
  const dbPath = join(resolvedStateDir, fileName);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    ensureKnownStoreVersion(db, dbPath);
    ensureRuntimeMeta(metaPath ?? defaultRuntimeMetaPath(resolvedStateDir));
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      run_id TEXT,
      turn_id TEXT,
      task_id TEXT,
      workspace TEXT,
      origin TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workspace TEXT,
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
    CREATE TABLE IF NOT EXISTS agents (
      instance_id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      display_name TEXT,
      contract_version TEXT NOT NULL,
      health TEXT NOT NULL,
      description TEXT NOT NULL,
      first_seen_at TEXT,
      last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      instance_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      version TEXT NOT NULL,
      default_requires_approval INTEGER DEFAULT 0,
      declaration TEXT NOT NULL,
      PRIMARY KEY (instance_id, capability_id, version)
    );
  `);
  ensureColumn(db, 'events', 'sequence', 'INTEGER');
  ensureColumn(db, 'events', 'workspace', 'TEXT');
  ensureColumn(db, 'events', 'task_id', 'TEXT');
  ensureColumn(db, 'runs', 'workspace', 'TEXT');
  backfillEventSequence(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)');
  db.exec(`PRAGMA user_version = ${RUNTIME_STORE_SCHEMA_VERSION}`);
  purgeOldTerminalRuns(db);

  let lastEventId = null;
  let lastEventSequence = null;

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (sequence, id, ts, type, run_id, turn_id, task_id, workspace, origin, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const nextEventSequenceStatement = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events');
  const listEventsStatement = db.prepare(`
    SELECT sequence, id, ts, type, run_id, turn_id, task_id, workspace, origin, payload
    FROM events
    ORDER BY sequence ASC
  `);
  const listEventsByWorkspaceStatement = db.prepare(`
    SELECT sequence, id, ts, type, run_id, turn_id, task_id, workspace, origin, payload
    FROM events
    WHERE workspace = ?
    ORDER BY sequence ASC
  `);
  const upsertRun = db.prepare(`
    INSERT INTO runs (id, workspace, status, input, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace = COALESCE(excluded.workspace, runs.workspace),
      status = excluded.status,
      input = COALESCE(excluded.input, runs.input),
      updated_at = excluded.updated_at
  `);
  const listRunsStatement = db.prepare(`
    SELECT id, workspace, status, input, created_at, updated_at
    FROM runs
    ORDER BY created_at DESC
  `);
  const listRunsByWorkspaceStatement = db.prepare(`
    SELECT id, workspace, status, input, created_at, updated_at
    FROM runs
    WHERE workspace = ?
    ORDER BY created_at DESC
  `);
  const listRecoverableRunsStatement = db.prepare(`
    SELECT id, workspace, status, input, created_at, updated_at
    FROM runs
    WHERE status IN (${RECOVERABLE_RUN_STATUSES.map(() => '?').join(', ')})
    ORDER BY created_at ASC
  `);
  const listRecoverableRunsByWorkspaceStatement = db.prepare(`
    SELECT id, workspace, status, input, created_at, updated_at
    FROM runs
    WHERE workspace = ? AND status IN (${RECOVERABLE_RUN_STATUSES.map(() => '?').join(', ')})
    ORDER BY created_at ASC
  `);
  const interruptRunsStatement = db.prepare(`
    UPDATE runs
    SET status = 'interrupted', updated_at = ?
    WHERE workspace = ? AND status IN (${RECOVERABLE_RUN_STATUSES.map(() => '?').join(', ')})
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
  const deleteMissingQueueItemsForWorkspace = db.prepare(`
    DELETE FROM queue_items
    WHERE workspace = ? AND id NOT IN (SELECT value FROM json_each(?))
  `);
  const clearQueueItemsForWorkspace = db.prepare('DELETE FROM queue_items WHERE workspace = ?');
  const clearQueueItems = db.prepare('DELETE FROM queue_items');
  const listQueueStatement = db.prepare(`
    SELECT id, workspace, server, tool, args, lock_key, status, reason, job_id, activity_key,
      error, created_at, started_at, finished_at, updated_at
    FROM queue_items
    ORDER BY COALESCE(created_at, updated_at) ASC, id ASC
  `);
  const listQueueByWorkspaceStatement = db.prepare(`
    SELECT id, workspace, server, tool, args, lock_key, status, reason, job_id, activity_key,
      error, created_at, started_at, finished_at, updated_at
    FROM queue_items
    WHERE workspace = ?
    ORDER BY COALESCE(created_at, updated_at) ASC, id ASC
  `);
  const listRecoverableWorkspacesStatement = db.prepare(`
    SELECT DISTINCT workspace FROM runs
    WHERE workspace IS NOT NULL AND status IN (${RECOVERABLE_RUN_STATUSES.map(() => '?').join(', ')})
    UNION
    SELECT DISTINCT workspace FROM queue_items
    WHERE workspace IS NOT NULL AND status IN (${RECOVERABLE_QUEUE_STATUSES.map(() => '?').join(', ')})
    ORDER BY workspace
  `);
  const upsertAgentStatement = db.prepare(`
    INSERT INTO agents (
      instance_id, agent_type, display_name, contract_version, health,
      description, first_seen_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      agent_type = excluded.agent_type,
      display_name = excluded.display_name,
      contract_version = excluded.contract_version,
      health = excluded.health,
      description = excluded.description,
      first_seen_at = COALESCE(agents.first_seen_at, excluded.first_seen_at),
      last_seen_at = excluded.last_seen_at
  `);
  const deleteAgentCapabilitiesStatement = db.prepare('DELETE FROM agent_capabilities WHERE instance_id = ?');
  const upsertAgentCapabilityStatement = db.prepare(`
    INSERT INTO agent_capabilities (
      instance_id, capability_id, version, default_requires_approval, declaration
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(instance_id, capability_id, version) DO UPDATE SET
      default_requires_approval = excluded.default_requires_approval,
      declaration = excluded.declaration
  `);
  const listAgentsStatement = db.prepare(`
    SELECT instance_id, agent_type, display_name, contract_version, health,
      description, first_seen_at, last_seen_at
    FROM agents
    ORDER BY instance_id ASC
  `);

  function persistEvent(event) {
    if (NON_PERSISTED_EVENT_TYPES.has(event.type)) return event;
    const ws = event.workspace ?? event.payload?.workspace ?? null;
    const sequence = nextEventSequenceStatement.get().next_sequence;
    const result = insertEvent.run(
      sequence,
      event.id,
      event.ts,
      event.type,
      event.runId ?? null,
      event.turnId ?? null,
      event.taskId ?? event.payload?.taskId ?? null,
      ws,
      event.origin ?? null,
      JSON.stringify(event.payload ?? {}),
    );
    if (Number(result.changes ?? 0) > 0) {
      event.sequence = sequence;
      lastEventId = event.id;
      lastEventSequence = sequence;
    }
    if (event.type === 'run_started') {
      persistRun({
        id: event.runId ?? event.payload?.runId ?? event.id,
        status: 'running',
        input: event.payload?.input ?? null,
        workspace: ws,
        createdAt: event.ts,
        updatedAt: event.ts,
      });
    } else if (RUN_STATUS_BY_EVENT[event.type]) {
      const runId = event.runId ?? event.payload?.runId ?? null;
      if (runId) {
        persistRun({
          id: runId,
          status: RUN_STATUS_BY_EVENT[event.type],
          workspace: ws,
          updatedAt: event.ts,
        });
      }
    }
    persistAgentFromEvent(event);
    return event;
  }

  function persistRun({ id, status, input = null, workspace = null, createdAt = null, updatedAt = null }) {
    if (!id) return;
    const now = new Date().toISOString();
    upsertRun.run(id, workspace, status, input, createdAt ?? now, updatedAt ?? now);
  }

  function listEvents({ workspace = null } = {}) {
    const rows = workspace
      ? listEventsByWorkspaceStatement.all(workspace)
      : listEventsStatement.all();
    return rows.map(rowToEvent);
  }

  function listAuditTrail({ workspace = null, runId = null } = {}) {
    return listEvents({ workspace })
      .filter((event) => !runId || event.runId === runId || event.payload?.runId === runId)
      .map(eventToAuditEntry);
  }

  function listRuns({ workspace = null } = {}) {
    const rows = workspace
      ? listRunsByWorkspaceStatement.all(workspace)
      : listRunsStatement.all();
    return rows.map((row) => ({
      id: row.id,
      workspace: row.workspace ?? null,
      status: row.status,
      input: row.input,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  function listRecoverableRuns({ workspace = null } = {}) {
    const rows = workspace
      ? listRecoverableRunsByWorkspaceStatement.all(workspace, ...RECOVERABLE_RUN_STATUSES)
      : listRecoverableRunsStatement.all(...RECOVERABLE_RUN_STATUSES);
    return rows.map((row) => ({
      id: row.id,
      workspace: row.workspace ?? null,
      status: row.status,
      input: row.input,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  function listRecoverableWorkspaces() {
    return listRecoverableWorkspacesStatement
      .all(...RECOVERABLE_RUN_STATUSES, ...RECOVERABLE_QUEUE_STATUSES)
      .map((row) => row.workspace);
  }

  function interruptRuns({ workspace, reason = 'Runtime restart recovery failed.' } = {}) {
    if (!workspace) return 0;
    const now = new Date().toISOString();
    const result = interruptRunsStatement.run(now, workspace, ...RECOVERABLE_RUN_STATUSES);
    return Number(result.changes ?? 0);
  }

  function saveQueue(queue = [], { workspace = null } = {}) {
    const items = Array.isArray(queue) ? queue : [];
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      if (items.length === 0) {
        if (workspace) clearQueueItemsForWorkspace.run(workspace);
        else clearQueueItems.run();
      } else {
        if (workspace) deleteMissingQueueItemsForWorkspace.run(workspace, JSON.stringify(items.map((item) => item.id)));
        else deleteMissingQueueItems.run(JSON.stringify(items.map((item) => item.id)));
        for (const item of items) {
          upsertQueueItem.run(
            item.id,
            item.workspace ?? workspace ?? null,
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

  function persistAgent(agent) {
    if (!agent?.agentInstanceId || !agent.description) return;
    const description = agent.description;
    const capabilities = Array.isArray(description.capabilities) ? description.capabilities : [];
    const firstSeenAt = agent.firstSeenAt ?? agent.lastSeenAt ?? new Date().toISOString();
    const lastSeenAt = agent.lastSeenAt ?? firstSeenAt;
    db.exec('BEGIN');
    try {
      upsertAgentStatement.run(
        agent.agentInstanceId,
        description.agentType ?? agent.serverName ?? 'unknown',
        description.displayName ?? agent.agentInstanceId,
        description.contractVersion ?? 'legacy',
        agent.health ?? description.health?.status ?? 'unavailable',
        JSON.stringify(description),
        firstSeenAt,
        lastSeenAt,
      );
      deleteAgentCapabilitiesStatement.run(agent.agentInstanceId);
      for (const capability of capabilities) {
        upsertAgentCapabilityStatement.run(
          agent.agentInstanceId,
          capability.id,
          capability.version,
          capability.defaultRequiresApproval === true ? 1 : 0,
          JSON.stringify(capability),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function persistAgentFromEvent(event) {
    if (event.type !== 'agent.registered' && event.type !== 'agent.health_changed') return;
    persistAgent(event.payload?.agent);
  }

  function listAgents() {
    return listAgentsStatement.all().map((row) => {
      const description = row.description ? JSON.parse(row.description) : null;
      return {
        agentInstanceId: row.instance_id,
        description,
        health: row.health,
        firstSeenAt: row.first_seen_at ?? null,
        lastSeenAt: row.last_seen_at ?? null,
        legacy: description?.contractVersion === 'legacy',
        orchestrable: description?.contractVersion !== 'legacy',
      };
    });
  }

  function listQueue({ workspace = null } = {}) {
    const rows = workspace
      ? listQueueByWorkspaceStatement.all(workspace)
      : listQueueStatement.all();
    return rows.map((row) => ({
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

  function replayEvents(session, { workspace = null } = {}) {
    const events = listEvents({ workspace });
    for (const event of events) {
      dispatchAgentEvent(session, event);
    }
    if (events.length > 0) {
      lastEventId = events.at(-1).id;
      lastEventSequence = events.at(-1).sequence ?? null;
    }
    return session.agentProjection ?? reduceAgentEvents([]);
  }

  function getProjection({ workspace = null } = {}) {
    return reduceAgentEvents(listEvents({ workspace }));
  }

  function getState(session = null, { workspace = null } = {}) {
    const events = session?.agentProjection ? null : listEvents({ workspace });
    const projection = session?.agentProjection ?? reduceAgentEvents(events);
    const rawQueue = session?.queueStore?.list() ?? listQueue({ workspace });
    const queue = projectQueue(projection.plan, rawQueue, { workspace });
    const controlQueue = Array.isArray(projection.controlQueue)
      ? projection.controlQueue.filter((item) => !workspace || item.workspace === workspace || !item.workspace).map((item) => ({ ...item }))
      : [];
    const agents = mergeAgents(
      listAgents(),
      projection.agents ?? [],
      session?.agentRegistry?.snapshot?.() ?? [],
    );
    const baseState = {
      ...projection,
      queue,
      controlQueue,
      agents,
      capabilityRegistry: createCapabilityRegistry({ agents }).snapshot(),
      eventsCursor: session?.agentEvents?.at(-1)?.sequence ?? events?.at(-1)?.sequence ?? lastEventSequence,
    };
    const runs = listRuns({ workspace });
    return {
      ...baseState,
      runs,
      workflow: projectWorkflow({ ...baseState, runs, workspace }, events ?? session?.agentEvents ?? []),
    };
  }

  function hydrateSession(session, { workspace = null } = {}) {
    const projection = replayEvents(session, { workspace });
    applyAgentProjectionToSession(session, projection);
    session.jobQueue = listQueue({ workspace });
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
    listAuditTrail,
    listRuns,
    listRecoverableRuns,
    listRecoverableWorkspaces,
    interruptRuns,
    saveQueue,
    listQueue,
    persistAgent,
    listAgents,
    replayEvents,
    hydrateSession,
    getProjection,
    getState,
    close,
  };
}

function defaultRuntimeMetaPath(stateDir) {
  return join(stateDir, 'meta.json');
}

function ensureKnownStoreVersion(db, dbPath) {
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row?.user_version ?? 0);
  if (version > RUNTIME_STORE_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime store schema version ${version} in ${dbPath}; this manager supports version ${RUNTIME_STORE_SCHEMA_VERSION}. Upgrade llm-wiki-manager before opening this runtime store.`);
  }
}

function ensureRuntimeMeta(metaPath) {
  migrateLegacyRuntimeMeta(metaPath);
  mkdirSync(dirname(metaPath), { recursive: true });
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, `${JSON.stringify({ schemaVersion: RUNTIME_STORE_SCHEMA_VERSION }, null, 2)}\n`, 'utf8');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid runtime metadata file ${metaPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const version = Number(parsed?.schemaVersion ?? 0);
  if (version > RUNTIME_STORE_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime metadata schemaVersion ${version} in ${metaPath}; this manager supports version ${RUNTIME_STORE_SCHEMA_VERSION}. Upgrade llm-wiki-manager before opening this runtime state.`);
  }
  if (!version) {
    writeFileSync(metaPath, `${JSON.stringify({ ...parsed, schemaVersion: RUNTIME_STORE_SCHEMA_VERSION }, null, 2)}\n`, 'utf8');
  }
}

function migrateLegacyRuntimeMeta(metaPath) {
  if (existsSync(metaPath)) return;
  const legacyPath = join(dirname(metaPath), '..', '.wiki', 'meta.json');
  if (!existsSync(legacyPath)) return;
  mkdirSync(dirname(metaPath), { recursive: true });
  renameSync(legacyPath, metaPath);
}

function purgeOldTerminalRuns(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - RUNTIME_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = TERMINAL_RUN_STATUSES.map(() => '?').join(', ');
  const oldRuns = db
    .prepare(`SELECT id FROM runs WHERE status IN (${placeholders}) AND updated_at < ?`)
    .all(...TERMINAL_RUN_STATUSES, cutoff)
    .map((row) => row.id);
  if (oldRuns.length === 0) return 0;
  db.exec('BEGIN');
  try {
    const deleteEvents = db.prepare('DELETE FROM events WHERE run_id = ? OR json_extract(payload, \'$.runId\') = ?');
    const deleteRun = db.prepare('DELETE FROM runs WHERE id = ?');
    for (const runId of oldRuns) {
      deleteEvents.run(runId, runId);
      deleteRun.run(runId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('VACUUM');
  return oldRuns.length;
}

function rowToEvent(row) {
  return {
    sequence: row.sequence ?? null,
    id: row.id,
    ts: row.ts,
    type: row.type,
    origin: row.origin ?? 'system',
    runId: row.run_id ?? null,
    turnId: row.turn_id ?? null,
    taskId: row.task_id ?? null,
    workspace: row.workspace ?? null,
    payload: row.payload ? JSON.parse(row.payload) : {},
  };
}

function eventToAuditEntry(event) {
  const payload = event.payload ?? {};
  const activity = payload.activity ?? {};
  return {
    sequence: event.sequence ?? null,
    ts: event.ts,
    type: event.type,
    runId: event.runId ?? payload.runId ?? null,
    turnId: event.turnId ?? payload.turnId ?? null,
    taskId: event.taskId ?? payload.taskId ?? activity.taskId ?? null,
    activityId: payload.activityId ?? activity.id ?? activity.key ?? null,
    toolCallId: payload.toolCallId ?? payload.callId ?? null,
    workspace: event.workspace ?? payload.workspace ?? null,
    caller: event.origin ?? payload.caller ?? 'system',
    status: payload.status ?? activity.status ?? null,
    tool: payload.tool ?? payload.name ?? activity.tool ?? null,
    summary: auditSummary(event),
  };
}

function auditSummary(event) {
  const payload = event.payload ?? {};
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.summary === 'string') return payload.summary;
  if (typeof payload.input === 'string') return payload.input;
  if (typeof payload.content === 'string') return payload.content.slice(0, 240);
  if (payload.activity?.label) return payload.activity.label;
  return event.type;
}

function mergeAgents(...groups) {
  const byId = new Map();
  for (const agents of groups) {
    for (const agent of agents ?? []) {
      if (!agent?.agentInstanceId) continue;
      byId.set(agent.agentInstanceId, {
        ...(byId.get(agent.agentInstanceId) ?? {}),
        ...agent,
        description: agent.description ?? byId.get(agent.agentInstanceId)?.description ?? null,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.agentInstanceId.localeCompare(b.agentInstanceId));
}

function ensureColumn(db, table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillEventSequence(db) {
  db.exec(`
    UPDATE events
    SET sequence = rowid
    WHERE sequence IS NULL
  `);
}
