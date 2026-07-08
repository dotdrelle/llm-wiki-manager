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
    CREATE TABLE IF NOT EXISTS task_groups (
      run_id TEXT NOT NULL,
      id TEXT NOT NULL,
      local_id TEXT,
      label TEXT NOT NULL,
      recommended_concurrency INTEGER,
      progress_weight REAL,
      declaration TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (run_id, id),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tasks (
      run_id TEXT NOT NULL,
      id TEXT NOT NULL,
      local_id TEXT,
      agent_instance_id TEXT,
      label TEXT NOT NULL,
      required_capability TEXT NOT NULL,
      operation TEXT NOT NULL,
      arguments TEXT NOT NULL,
      group_id TEXT,
      depends_on_group TEXT,
      barrier INTEGER DEFAULT 0,
      parallelizable INTEGER DEFAULT 0,
      recommended_concurrency INTEGER,
      input_refs TEXT NOT NULL,
      expected_output_refs TEXT NOT NULL,
      locks TEXT NOT NULL,
      requires_approval INTEGER DEFAULT 0,
      approval_class TEXT,
      approval_summary TEXT,
      idempotency_key TEXT,
      progress_weight REAL NOT NULL,
      priority REAL,
      retry_policy TEXT,
      declaration TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (run_id, id),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS task_dependencies (
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY (run_id, task_id, depends_on_task_id),
      FOREIGN KEY (run_id, task_id) REFERENCES tasks(run_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS plan_revisions (
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      previous_revision INTEGER,
      reason TEXT,
      task_ids TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY (run_id, revision),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS task_assignments (
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      agent_id TEXT,
      pool_id TEXT,
      assigned_at TEXT NOT NULL,
      PRIMARY KEY (task_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS task_attempts (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      job_id TEXT,
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS task_results (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      output_refs TEXT,
      metrics TEXT,
      error TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS approval_grants (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workspace_id TEXT,
      plan_revision INTEGER,
      scope TEXT NOT NULL,
      task_id TEXT,
      group_id TEXT,
      approval_classes TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      granted_at TEXT,
      rejected_at TEXT
    );
  `);
  ensureColumn(db, 'events', 'sequence', 'INTEGER');
  ensureColumn(db, 'events', 'workspace', 'TEXT');
  ensureColumn(db, 'events', 'task_id', 'TEXT');
  ensureColumn(db, 'runs', 'workspace', 'TEXT');
  backfillEventSequence(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_attempts_run ON task_attempts(run_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_approval_grants_run_revision ON approval_grants(run_id, workspace_id, plan_revision, status)');
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
  const ensureRun = db.prepare(`
    INSERT OR IGNORE INTO runs (id, workspace, status, input, created_at, updated_at)
    VALUES (?, ?, 'running', NULL, ?, ?)
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
  const upsertTaskGroupStatement = db.prepare(`
    INSERT INTO task_groups (
      run_id, id, local_id, label, recommended_concurrency, progress_weight,
      declaration, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, id) DO UPDATE SET
      label = excluded.label,
      recommended_concurrency = excluded.recommended_concurrency,
      progress_weight = excluded.progress_weight,
      declaration = excluded.declaration,
      updated_at = excluded.updated_at
  `);
  const upsertTaskStatement = db.prepare(`
    INSERT INTO tasks (
      run_id, id, local_id, agent_instance_id, label, required_capability,
      operation, arguments, group_id, depends_on_group, barrier, parallelizable,
      recommended_concurrency, input_refs, expected_output_refs, locks,
      requires_approval, approval_class, approval_summary, idempotency_key,
      progress_weight, priority, retry_policy, declaration, status, created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, id) DO UPDATE SET
      agent_instance_id = excluded.agent_instance_id,
      label = excluded.label,
      required_capability = excluded.required_capability,
      operation = excluded.operation,
      arguments = excluded.arguments,
      group_id = excluded.group_id,
      depends_on_group = excluded.depends_on_group,
      barrier = excluded.barrier,
      parallelizable = excluded.parallelizable,
      recommended_concurrency = excluded.recommended_concurrency,
      input_refs = excluded.input_refs,
      expected_output_refs = excluded.expected_output_refs,
      locks = excluded.locks,
      requires_approval = excluded.requires_approval,
      approval_class = excluded.approval_class,
      approval_summary = excluded.approval_summary,
      idempotency_key = excluded.idempotency_key,
      progress_weight = excluded.progress_weight,
      priority = excluded.priority,
      retry_policy = excluded.retry_policy,
      declaration = excluded.declaration,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const deleteTaskDependenciesStatement = db.prepare('DELETE FROM task_dependencies WHERE run_id = ? AND task_id = ?');
  const updateTaskStatusStatement = db.prepare('UPDATE tasks SET status = ?, declaration = ?, updated_at = ? WHERE run_id = ? AND id = ?');
  const insertTaskDependencyStatement = db.prepare(`
    INSERT OR IGNORE INTO task_dependencies (run_id, task_id, depends_on_task_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertPlanRevisionStatement = db.prepare(`
    INSERT OR REPLACE INTO plan_revisions (
      run_id, revision, previous_revision, reason, task_ids, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listTasksStatement = db.prepare(`
    SELECT * FROM tasks ORDER BY run_id ASC, id ASC
  `);
  const listTasksByRunStatement = db.prepare(`
    SELECT * FROM tasks WHERE run_id = ? ORDER BY id ASC
  `);
  const listTaskDependenciesStatement = db.prepare(`
    SELECT * FROM task_dependencies ORDER BY run_id ASC, task_id ASC, depends_on_task_id ASC
  `);
  const listTaskDependenciesByRunStatement = db.prepare(`
    SELECT * FROM task_dependencies WHERE run_id = ? ORDER BY task_id ASC, depends_on_task_id ASC
  `);
  const listPlanRevisionsStatement = db.prepare(`
    SELECT * FROM plan_revisions ORDER BY run_id ASC, revision ASC
  `);
  const listPlanRevisionsByRunStatement = db.prepare(`
    SELECT * FROM plan_revisions WHERE run_id = ? ORDER BY revision ASC
  `);
  const upsertTaskAssignmentStatement = db.prepare(`
    INSERT INTO task_assignments (
      task_id, attempt_id, agent_instance_id, agent_id, pool_id, assigned_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, attempt_id) DO UPDATE SET
      agent_instance_id = excluded.agent_instance_id,
      agent_id = excluded.agent_id,
      pool_id = excluded.pool_id,
      assigned_at = excluded.assigned_at
  `);
  const upsertTaskAttemptStatement = db.prepare(`
    INSERT INTO task_attempts (
      attempt_id, task_id, run_id, status, job_id, started_at, finished_at, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(attempt_id) DO UPDATE SET
      task_id = excluded.task_id,
      run_id = excluded.run_id,
      status = excluded.status,
      job_id = COALESCE(excluded.job_id, task_attempts.job_id),
      started_at = COALESCE(task_attempts.started_at, excluded.started_at),
      finished_at = COALESCE(excluded.finished_at, task_attempts.finished_at),
      error = COALESCE(excluded.error, task_attempts.error)
  `);
  const upsertTaskResultStatement = db.prepare(`
    INSERT INTO task_results (
      attempt_id, task_id, status, summary, output_refs, metrics, error, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(attempt_id) DO UPDATE SET
      task_id = excluded.task_id,
      status = excluded.status,
      summary = COALESCE(excluded.summary, task_results.summary),
      output_refs = CASE WHEN excluded.output_refs = '[]' THEN task_results.output_refs ELSE excluded.output_refs END,
      metrics = CASE WHEN excluded.metrics = '{}' THEN task_results.metrics ELSE excluded.metrics END,
      error = COALESCE(excluded.error, task_results.error),
      created_at = excluded.created_at
  `);
  const listTaskAssignmentsStatement = db.prepare(`
    SELECT * FROM task_assignments WHERE task_id = ? ORDER BY assigned_at ASC, attempt_id ASC
  `);
  const listTaskAttemptsStatement = db.prepare(`
    SELECT * FROM task_attempts WHERE task_id = ? ORDER BY COALESCE(started_at, finished_at, attempt_id) ASC, attempt_id ASC
  `);
  const latestTaskAttemptStatement = db.prepare(`
    SELECT * FROM task_attempts WHERE task_id = ? ORDER BY COALESCE(started_at, finished_at, attempt_id) DESC, attempt_id DESC LIMIT 1
  `);
  const latestTaskResultStatement = db.prepare(`
    SELECT * FROM task_results WHERE task_id = ? ORDER BY COALESCE(created_at, attempt_id) DESC, attempt_id DESC LIMIT 1
  `);
  const upsertApprovalGrantStatement = db.prepare(`
    INSERT INTO approval_grants (
      id, run_id, workspace_id, plan_revision, scope, task_id, group_id,
      approval_classes, status, reason, created_at, granted_at, rejected_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      run_id = excluded.run_id,
      workspace_id = excluded.workspace_id,
      plan_revision = excluded.plan_revision,
      scope = excluded.scope,
      task_id = excluded.task_id,
      group_id = excluded.group_id,
      approval_classes = excluded.approval_classes,
      status = excluded.status,
      reason = COALESCE(excluded.reason, approval_grants.reason),
      granted_at = COALESCE(excluded.granted_at, approval_grants.granted_at),
      rejected_at = COALESCE(excluded.rejected_at, approval_grants.rejected_at)
  `);
  const listApprovalGrantsStatement = db.prepare(`
    SELECT * FROM approval_grants ORDER BY created_at ASC, id ASC
  `);
  const listApprovalGrantsByRunStatement = db.prepare(`
    SELECT * FROM approval_grants WHERE run_id = ? ORDER BY created_at ASC, id ASC
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
    persistPlanFromEvent(event);
    persistTaskLifecycleFromEvent(event);
    persistApprovalGrantFromEvent(event);
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

  function persistPlanFromEvent(event) {
    if (!['task_group.created', 'task.created', 'plan.revision_changed'].includes(event.type)) return;
    const runId = event.runId ?? event.payload?.runId ?? null;
    if (!runId) return;
    ensureRun.run(runId, event.workspace ?? event.payload?.workspace ?? null, event.ts, event.ts);
    if (event.type === 'task_group.created') persistTaskGroup(runId, event.payload?.group, event.ts);
    else if (event.type === 'task.created') persistTask(runId, event.payload?.task, event.ts);
    else persistPlanRevision(runId, event.payload ?? {}, event.ts);
  }

  function persistTaskGroup(runId, group, ts) {
    if (!group?.id) return;
    upsertTaskGroupStatement.run(
      runId,
      group.id,
      group.localId ?? null,
      group.label ?? group.id,
      group.recommendedConcurrency ?? null,
      group.progressWeight ?? null,
      JSON.stringify(group),
      group.createdAt ?? ts,
      group.updatedAt ?? ts,
    );
  }

  function persistTask(runId, task, ts) {
    if (!task?.id) return;
    db.exec('BEGIN');
    try {
      upsertTaskStatement.run(
        runId,
        task.id,
        task.localId ?? null,
        task.agentInstanceId ?? null,
        task.label ?? task.description ?? task.id,
        task.requiredCapability ?? '',
        task.operation ?? '',
        JSON.stringify(task.arguments ?? {}),
        task.groupId ?? null,
        task.dependsOnGroup ?? null,
        task.barrier === true ? 1 : 0,
        task.parallelizable === true ? 1 : 0,
        task.recommendedConcurrency ?? null,
        JSON.stringify(task.inputRefs ?? []),
        JSON.stringify(task.expectedOutputRefs ?? []),
        JSON.stringify(task.locks ?? []),
        task.requiresApproval === true ? 1 : 0,
        task.approvalClass ?? null,
        task.approvalSummary ?? null,
        task.idempotencyKey ?? null,
        task.progressWeight ?? 1,
        task.priority ?? null,
        task.retryPolicy == null ? null : JSON.stringify(task.retryPolicy),
        JSON.stringify(task),
        task.status ?? 'pending',
        task.createdAt ?? ts,
        task.updatedAt ?? ts,
      );
      deleteTaskDependenciesStatement.run(runId, task.id);
      for (const dependencyId of task.dependsOn ?? []) {
        insertTaskDependencyStatement.run(runId, task.id, dependencyId, ts);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function persistPlanRevision(runId, payload, ts) {
    insertPlanRevisionStatement.run(
      runId,
      Number(payload.planRevision ?? payload.revision ?? 0),
      payload.previousRevision ?? null,
      payload.reason ?? null,
      JSON.stringify(payload.taskIds ?? []),
      ts,
    );
    if (Array.isArray(payload.tasks)) {
      for (const task of payload.tasks) persistTask(runId, task, ts);
    }
  }

  function persistTaskLifecycleFromEvent(event) {
    const taskId = lifecycleTaskId(event);
    const runId = event.runId ?? event.payload?.runId ?? event.payload?.result?.runId ?? null;
    if (!taskId || !runId) return;

    if (event.type === 'plan_step_updated') {
      const task = event.payload?.task;
      const status = event.payload?.status ?? task?.status ?? null;
      if (status) {
        const existing = listTasksByRunStatement.all(runId).map(rowToTask).find((item) => item.id === taskId);
        if (existing) {
          updateTaskStatusStatement.run(
            String(status),
            JSON.stringify({ ...existing.declaration, ...task, status: String(status) }),
            event.ts,
            runId,
            taskId,
          );
        }
      }
      return;
    }

    if (![
      'task.assigned',
      'task.started',
      'task.retry_scheduled',
      'task.result_returned',
      'task.completed',
      'task.failed',
    ].includes(event.type)) return;
    const attemptId = lifecycleAttemptId(event, taskId);

    if (event.type === 'task.assigned') {
      const assignment = event.payload?.assignment ?? {};
      const agentInstanceId = event.payload?.agentInstanceId ?? assignment.agentInstanceId;
      if (agentInstanceId) {
        upsertTaskAssignmentStatement.run(
          taskId,
          attemptId,
          String(agentInstanceId),
          event.payload?.agentId ?? assignment.agentId ?? null,
          event.payload?.poolId ?? assignment.poolId ?? null,
          event.payload?.assignedAt ?? event.ts,
        );
      }
      persistTaskAttempt({
        attemptId,
        taskId,
        runId,
        status: event.payload?.status ?? 'assigned',
        startedAt: null,
        finishedAt: null,
        jobId: null,
        error: null,
      });
      return;
    }

    if (event.type === 'task.started') {
      persistTaskAttempt({
        attemptId,
        taskId,
        runId,
        status: event.payload?.status ?? 'running',
        startedAt: event.payload?.startedAt ?? event.ts,
        finishedAt: null,
        jobId: event.payload?.jobId ?? event.payload?.result?.jobId ?? null,
        error: null,
      });
      return;
    }

    if (event.type === 'task.retry_scheduled') {
      persistTaskAttempt({
        attemptId,
        taskId,
        runId,
        status: event.payload?.status ?? 'retry_scheduled',
        startedAt: null,
        finishedAt: null,
        jobId: event.payload?.jobId ?? null,
        error: stringifyError(event.payload?.error ?? event.payload?.reason ?? null),
      });
      return;
    }

    const result = event.payload?.result ?? {};
    const status = resultStatusForEvent(event, result);
    persistTaskAttempt({
      attemptId,
      taskId,
      runId,
      status: attemptStatusForResult(status, event.type),
      startedAt: null,
      finishedAt: event.ts,
      jobId: result.jobId ?? event.payload?.jobId ?? null,
      error: stringifyError(result.error ?? event.payload?.error ?? null),
    });
    upsertTaskResultStatement.run(
      attemptId,
      taskId,
      status,
      result.summary ?? event.payload?.summary ?? null,
      JSON.stringify(result.outputRefs ?? result.result?.outputRefs ?? []),
      JSON.stringify(result.metrics ?? result.result?.metrics ?? {}),
      stringifyError(result.error ?? event.payload?.error ?? null),
      event.payload?.createdAt ?? event.ts,
    );
  }

  function persistTaskAttempt({ attemptId, taskId, runId, status, jobId, startedAt, finishedAt, error }) {
    upsertTaskAttemptStatement.run(
      attemptId,
      taskId,
      runId,
      status,
      jobId,
      startedAt,
      finishedAt,
      error,
    );
  }

  function persistApprovalGrantFromEvent(event) {
    if (!['approval.requested', 'approval.granted', 'approval.rejected'].includes(event.type)) return;
    const payload = event.payload ?? {};
    const runId = event.runId ?? payload.runId ?? null;
    if (!runId) return;
    const id = payload.id ?? payload.approvalId ?? payload.taskId ?? payload.itemId ?? payload.groupId ?? event.id;
    const status = event.type === 'approval.requested'
      ? 'pending_approval'
      : event.type === 'approval.rejected'
        ? 'rejected'
        : 'approved';
    upsertApprovalGrantStatement.run(
      String(id),
      String(runId),
      event.workspace ?? payload.workspaceId ?? payload.workspace ?? null,
      payload.planRevision == null ? null : Number(payload.planRevision),
      String(payload.scope ?? 'run'),
      payload.taskId ?? payload.itemId ?? event.taskId ?? null,
      payload.groupId ?? null,
      JSON.stringify(normalizeApprovalClasses(payload.approvalClasses ?? payload.approvalClass)),
      status,
      payload.reason ?? null,
      payload.createdAt ?? event.ts,
      status === 'approved' ? (payload.grantedAt ?? event.ts) : null,
      status === 'rejected' ? (payload.rejectedAt ?? event.ts) : null,
    );
  }

  function lifecycleTaskId(event) {
    const taskId = event.taskId ?? event.payload?.taskId ?? event.payload?.result?.taskId;
    return taskId == null ? null : String(taskId);
  }

  function lifecycleAttemptId(event, taskId) {
    const attemptId = event.payload?.attemptId
      ?? event.payload?.assignment?.attemptId
      ?? event.payload?.result?.attemptId;
    if (attemptId != null) return String(attemptId);
    return latestTaskAttemptStatement.get(taskId)?.attempt_id ?? `${taskId}:attempt-1`;
  }

  function resultStatusForEvent(event, result) {
    if (result?.status) return String(result.status);
    if (event.type === 'task.completed') return 'succeeded';
    if (event.type === 'task.failed') return 'failed';
    return 'unknown';
  }

  function attemptStatusForResult(status, eventType) {
    const normalized = String(status ?? '').toLowerCase();
    if (['succeeded', 'success', 'done', 'complete', 'completed'].includes(normalized)) return 'done';
    if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
    if (eventType === 'task.failed') return 'failed';
    return normalized || 'finished';
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

  function listTasks({ runId = null } = {}) {
    const rows = runId ? listTasksByRunStatement.all(runId) : listTasksStatement.all();
    return rows.map(rowToTask);
  }

  function listTaskAssignments({ taskId }) {
    if (!taskId) return [];
    return listTaskAssignmentsStatement.all(String(taskId)).map(rowToTaskAssignment);
  }

  function listTaskAttempts({ taskId }) {
    if (!taskId) return [];
    return listTaskAttemptsStatement.all(String(taskId)).map(rowToTaskAttempt);
  }

  function getTaskResult({ taskId }) {
    if (!taskId) return null;
    const row = latestTaskResultStatement.get(String(taskId));
    return row ? rowToTaskResult(row) : null;
  }

  function listApprovalGrants({ runId = null } = {}) {
    const rows = runId ? listApprovalGrantsByRunStatement.all(String(runId)) : listApprovalGrantsStatement.all();
    return rows.map(rowToApprovalGrant);
  }

  function listTaskDependencies({ runId = null } = {}) {
    const rows = runId ? listTaskDependenciesByRunStatement.all(runId) : listTaskDependenciesStatement.all();
    return rows.map((row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      dependsOnTaskId: row.depends_on_task_id,
      createdAt: row.created_at ?? null,
    }));
  }

  function listPlanRevisions({ runId = null } = {}) {
    const rows = runId ? listPlanRevisionsByRunStatement.all(runId) : listPlanRevisionsStatement.all();
    return rows.map((row) => ({
      runId: row.run_id,
      revision: row.revision,
      previousRevision: row.previous_revision ?? null,
      reason: row.reason ?? null,
      taskIds: row.task_ids ? JSON.parse(row.task_ids) : [],
      createdAt: row.created_at ?? null,
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
    listTasks,
    listTaskAssignments,
    listTaskAttempts,
    getTaskResult,
    listApprovalGrants,
    listTaskDependencies,
    listPlanRevisions,
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

function rowToTask(row) {
  return {
    runId: row.run_id,
    id: row.id,
    localId: row.local_id ?? null,
    agentInstanceId: row.agent_instance_id ?? null,
    label: row.label,
    requiredCapability: row.required_capability,
    operation: row.operation,
    arguments: row.arguments ? JSON.parse(row.arguments) : {},
    groupId: row.group_id ?? null,
    dependsOnGroup: row.depends_on_group ?? null,
    barrier: Boolean(row.barrier),
    parallelizable: Boolean(row.parallelizable),
    recommendedConcurrency: row.recommended_concurrency ?? null,
    inputRefs: row.input_refs ? JSON.parse(row.input_refs) : [],
    expectedOutputRefs: row.expected_output_refs ? JSON.parse(row.expected_output_refs) : [],
    locks: row.locks ? JSON.parse(row.locks) : [],
    requiresApproval: Boolean(row.requires_approval),
    approvalClass: row.approval_class ?? null,
    approvalSummary: row.approval_summary ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    progressWeight: row.progress_weight,
    priority: row.priority ?? null,
    retryPolicy: row.retry_policy ? JSON.parse(row.retry_policy) : null,
    declaration: row.declaration ? JSON.parse(row.declaration) : null,
    status: row.status,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function rowToTaskAssignment(row) {
  return {
    taskId: row.task_id,
    attemptId: row.attempt_id,
    agentInstanceId: row.agent_instance_id,
    agentId: row.agent_id ?? null,
    poolId: row.pool_id ?? null,
    assignedAt: row.assigned_at,
  };
}

function rowToTaskAttempt(row) {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    runId: row.run_id,
    status: row.status,
    jobId: row.job_id ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    error: row.error ? parseJsonMaybe(row.error) : null,
  };
}

function rowToTaskResult(row) {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    status: row.status,
    summary: row.summary ?? null,
    outputRefs: row.output_refs ? JSON.parse(row.output_refs) : [],
    metrics: row.metrics ? JSON.parse(row.metrics) : {},
    error: row.error ? parseJsonMaybe(row.error) : null,
    createdAt: row.created_at ?? null,
  };
}

function rowToApprovalGrant(row) {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id ?? null,
    planRevision: row.plan_revision ?? null,
    scope: row.scope,
    taskId: row.task_id ?? null,
    groupId: row.group_id ?? null,
    approvalClasses: row.approval_classes ? JSON.parse(row.approval_classes) : [],
    status: row.status,
    reason: row.reason ?? null,
    createdAt: row.created_at,
    grantedAt: row.granted_at ?? null,
    rejectedAt: row.rejected_at ?? null,
  };
}

function normalizeApprovalClasses(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function parseJsonMaybe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyError(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
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
