import { randomUUID } from 'node:crypto';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { normalizeApprovalGrant } from '../orchestrator/approvalPolicy.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export function createApprovalManager(session, {
  defaultTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
} = {}) {
  const pending = new Map();

  async function requestApproval(request = {}) {
    const scope = request.scope === 'tool' ? 'tool' : 'run';
    const approvalId = request.approvalId ?? randomUUID();
    const runId = request.runId ?? session._currentRunIdentity?.runId ?? null;
    const workspaceId = request.workspaceId ?? request.workspace ?? session._currentRunIdentity?.workspace ?? session.workspace ?? null;
    const planRevision = request.planRevision ?? session.planRevision ?? null;
    const approvalClasses = normalizeClasses(request.approvalClasses ?? request.approvalClass);
    const timeoutMs = Number.isFinite(Number(request.timeoutMs))
      ? Math.max(1, Number(request.timeoutMs))
      : defaultTimeoutMs;
    const eventType = scope === 'tool' ? 'tool_pending_approval' : 'run_pending_approval';
    const approvedType = scope === 'tool' ? 'tool_approved' : 'run_approved';

    dispatchAgentEvent(session, createAgentEvent(eventType, {
      origin: 'runtime',
      runId,
      payload: {
        approvalId,
        runId,
        itemId: request.itemId ?? null,
        reason: request.reason ?? null,
        tool: request.tool ?? null,
        plan: request.plan ?? null,
        timeoutMs,
      },
    }));
    dispatchAgentEvent(session, createAgentEvent('approval.requested', {
      origin: 'runtime',
      runId,
      taskId: request.taskId ?? request.itemId ?? null,
      workspace: workspaceId,
      payload: {
        id: approvalId,
        approvalId,
        scope: normalizeGrantScope(request.scope),
        runId,
        workspaceId,
        planRevision,
        taskId: request.taskId ?? request.itemId ?? null,
        itemId: request.itemId ?? request.taskId ?? null,
        groupId: request.groupId ?? null,
        approvalClasses,
        reason: request.reason ?? null,
      },
    }));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(approvalId);
        const err = new Error(`Approval timed out: ${approvalId}`);
        err.name = 'ApprovalError';
        reject(err);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        pending.delete(approvalId);
        cleanup();
        const err = new Error(`Approval cancelled: ${approvalId}`);
        err.name = 'AbortError';
        reject(err);
      };
      pending.set(approvalId, {
        approvalId,
        scope,
        grantScope: normalizeGrantScope(request.scope),
        runId,
        workspaceId,
        planRevision,
        itemId: request.itemId ?? null,
        taskId: request.taskId ?? request.itemId ?? null,
        groupId: request.groupId ?? null,
        approvalClasses,
        reason: request.reason ?? null,
        resolve: () => {
          pending.delete(approvalId);
          cleanup();
          resolve();
        },
      });
      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      request.signal?.addEventListener('abort', onAbort, { once: true });
    });

    dispatchAgentEvent(session, createAgentEvent(approvedType, {
      origin: 'runtime',
      runId,
      payload: {
        approvalId,
        runId,
        itemId: request.itemId ?? null,
      },
    }));
    const grant = normalizeApprovalGrant({
      id: approvalId,
      approvalId,
      scope: normalizeGrantScope(request.scope),
      runId,
      workspaceId,
      planRevision,
      taskId: request.taskId ?? request.itemId ?? null,
      itemId: request.itemId ?? request.taskId ?? null,
      groupId: request.groupId ?? null,
      approvalClasses,
      status: 'approved',
      reason: request.reason ?? null,
    });
    dispatchAgentEvent(session, createAgentEvent('approval.granted', {
      origin: 'runtime',
      runId,
      taskId: grant.taskId,
      workspace: workspaceId,
      payload: grant,
    }));
    return { approved: true, approvalId, runId, itemId: request.itemId ?? null };
  }

  function approve(request = {}) {
    const { approvalId = null, runId = null, itemId = null } = request;
    if (request.scope || request.planRevision != null || request.approvalClasses || request.approvalClass || request.taskId || request.groupId) {
      const grant = normalizeApprovalGrant({
        ...request,
        id: request.id ?? request.approvalId ?? randomUUID(),
        workspaceId: request.workspaceId ?? request.workspace ?? session.workspace ?? null,
        scope: normalizeGrantScope(request.scope),
        itemId: request.itemId ?? request.taskId ?? null,
        status: 'approved',
      });
      dispatchAgentEvent(session, createAgentEvent('approval.granted', {
        origin: 'runtime',
        runId: grant.runId,
        taskId: grant.taskId,
        workspace: grant.workspaceId,
        payload: grant,
      }));
      resolveMatchingPending(grant);
      return {
        approved: true,
        approvalId: grant.approvalId ?? grant.id,
        runId: grant.runId,
        itemId: grant.itemId,
        scope: grant.scope,
        planRevision: grant.planRevision,
        approvalClasses: grant.approvalClasses,
      };
    }
    const entry = approvalId
      ? pending.get(approvalId)
      : [...pending.values()].find((item) =>
          (runId && item.runId === runId) || (itemId && item.itemId === itemId),
        );
    if (!entry) return { approved: false, reason: 'approval not found' };
    entry.resolve();
    return {
      approved: true,
      approvalId: entry.approvalId,
      runId: entry.runId,
      itemId: entry.itemId,
    };
  }

  function reject(request = {}) {
    const grant = normalizeApprovalGrant({
      ...request,
      id: request.id ?? request.approvalId ?? randomUUID(),
      workspaceId: request.workspaceId ?? request.workspace ?? session.workspace ?? null,
      scope: normalizeGrantScope(request.scope),
      status: 'rejected',
    });
    dispatchAgentEvent(session, createAgentEvent('approval.rejected', {
      origin: 'runtime',
      runId: grant.runId,
      taskId: grant.taskId,
      workspace: grant.workspaceId,
      payload: grant,
    }));
    return {
      approved: false,
      rejected: true,
      approvalId: grant.approvalId ?? grant.id,
      runId: grant.runId,
      itemId: grant.itemId,
      scope: grant.scope,
    };
  }

  function list() {
    return [...pending.entries()].map(([approvalId, item]) => ({
      approvalId,
      scope: item.scope,
      runId: item.runId,
      itemId: item.itemId,
    }));
  }

  return {
    requestApproval,
    approve,
    reject,
    list,
  };

  function resolveMatchingPending(grant) {
    for (const entry of pending.values()) {
      if (grant.approvalId && entry.approvalId === grant.approvalId) entry.resolve();
      else if (grant.taskId && entry.taskId === grant.taskId) entry.resolve();
      else if (grant.itemId && entry.itemId === grant.itemId) entry.resolve();
      else if (grant.scope === 'run' && grant.runId && entry.runId === grant.runId) entry.resolve();
      else continue;
      break;
    }
  }
}

function normalizeGrantScope(scope) {
  const normalized = String(scope ?? 'run').toLowerCase();
  if (normalized === 'all') return 'run';
  if (['run', 'task', 'group', 'tool'].includes(normalized)) return normalized;
  return normalized === 'tool' ? 'tool' : 'run';
}

function normalizeClasses(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}
