import { randomUUID } from 'node:crypto';

export const APPROVAL_DEFAULT_CLASS = 'default';

const GRANTED_STATUSES = new Set(['approved', 'granted']);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'canceled', 'error', 'complete', 'completed', 'success']);

export function approvalClassForTask(task) {
  return String(task?.approvalClass ?? task?.mutationClass ?? APPROVAL_DEFAULT_CLASS);
}

export function normalizeApprovalGrant(input = {}) {
  const scope = normalizeScope(input.scope);
  const approvalClasses = normalizeClasses(input.approvalClasses ?? input.approvalClass);
  return {
    id: String(input.id ?? input.approvalId ?? randomUUID()),
    approvalId: input.approvalId == null ? null : String(input.approvalId),
    scope,
    status: normalizeStatus(input.status ?? 'approved'),
    runId: input.runId == null ? null : String(input.runId),
    workspaceId: input.workspaceId ?? input.workspace ?? null,
    planRevision: input.planRevision == null ? null : Number(input.planRevision),
    taskId: input.taskId ?? input.itemId ?? null,
    itemId: input.itemId ?? input.taskId ?? null,
    groupId: input.groupId ?? null,
    approvalClasses,
    reason: input.reason ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    grantedAt: input.grantedAt ?? (GRANTED_STATUSES.has(normalizeStatus(input.status ?? 'approved')) ? new Date().toISOString() : null),
    rejectedAt: input.rejectedAt ?? (normalizeStatus(input.status) === 'rejected' ? new Date().toISOString() : null),
  };
}

export function grantCoversTask(grant, task, {
  runId = null,
  workspaceId = null,
  planRevision = null,
} = {}) {
  if (task?.requiresApproval !== true) return true;
  if (task?.approved === true || task?.approvalStatus === 'approved') return true;
  if (!grant || !GRANTED_STATUSES.has(normalizeStatus(grant.status))) return false;
  if (grant.runId != null && runId != null && String(grant.runId) !== String(runId)) return false;
  const grantWorkspace = grant.workspaceId ?? grant.workspace ?? null;
  if (grantWorkspace != null && workspaceId != null && String(grantWorkspace) !== String(workspaceId)) return false;
  if (grant.planRevision != null && planRevision != null && Number(grant.planRevision) !== Number(planRevision)) return false;

  const classes = normalizeClasses(grant.approvalClasses ?? grant.approvalClass);
  if (classes.length > 0 && !classes.includes(approvalClassForTask(task))) return false;

  const taskIds = new Set([task.id, task.localId, task.taskId].filter(Boolean).map(String));
  const scope = normalizeScope(grant.scope);
  if (scope === 'run' || scope === 'all') return true;
  if (scope === 'group') return grant.groupId != null && String(grant.groupId) === String(task.groupId ?? '');
  if (scope === 'task' || scope === 'tool') {
    return [grant.taskId, grant.itemId, grant.approvalId, grant.id]
      .filter(Boolean)
      .some((id) => taskIds.has(String(id)));
  }
  return false;
}

export function approvalCovered(task, approvals = [], context = {}) {
  return task?.requiresApproval !== true
    || task?.approved === true
    || task?.approvalStatus === 'approved'
    || approvals.some((approval) => grantCoversTask(approval, task, context));
}

export function applyApprovalCoverage(tasks = [], {
  approvals = [],
  runId = null,
  workspaceId = null,
  planRevision = null,
} = {}) {
  const requested = [];
  for (const task of tasks) {
    if (task?.requiresApproval !== true || TERMINAL_STATUSES.has(String(task.status ?? '').toLowerCase())) continue;
    const covered = approvalCovered(task, approvals, { runId, workspaceId, planRevision });
    if (!covered) {
      task.status = 'waiting_approval';
      requested.push(approvalRequestForTask(task, { runId, workspaceId, planRevision }));
    } else if (task.status === 'waiting_approval' || task.status === 'pending_approval') {
      task.status = 'pending';
    }
  }
  return requested;
}

export function approvalRequestForTask(task, {
  runId = null,
  workspaceId = null,
  planRevision = null,
} = {}) {
  const approvalClass = approvalClassForTask(task);
  return {
    id: `approval:${runId ?? 'run'}:${task.id ?? task.localId ?? randomUUID()}:${approvalClass}`,
    scope: 'task',
    status: 'pending_approval',
    runId,
    workspaceId,
    planRevision,
    taskId: task.id ?? null,
    groupId: task.groupId ?? null,
    approvalClasses: [approvalClass],
    reason: task.approvalSummary ?? task.label ?? task.description ?? null,
  };
}

export function normalizeClasses(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeScope(scope) {
  const normalized = String(scope ?? 'run').toLowerCase();
  if (normalized === 'all') return 'run';
  if (['run', 'task', 'group', 'tool'].includes(normalized)) return normalized;
  return 'run';
}

function normalizeStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'granted') return 'approved';
  return normalized || 'approved';
}
