import { randomUUID } from 'node:crypto';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export function createApprovalManager(session, {
  defaultTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
} = {}) {
  const pending = new Map();

  async function requestApproval(request = {}) {
    const scope = request.scope === 'tool' ? 'tool' : 'run';
    const approvalId = request.approvalId ?? randomUUID();
    const runId = request.runId ?? session._currentRunIdentity?.runId ?? null;
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
        runId,
        itemId: request.itemId ?? null,
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
    return { approved: true, approvalId, runId, itemId: request.itemId ?? null };
  }

  function approve({ approvalId = null, runId = null, itemId = null } = {}) {
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
    list,
  };
}
