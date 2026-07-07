import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { extractActivity, parseJsonText, sessionActivities } from './activity.js';
import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';
import { callMcpTool, formatMcpToolResult } from './mcp.js';
import { queueStoreFor } from './queueStore.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'canceled', 'complete', 'completed', 'success', 'error']);

function now() {
  return new Date().toISOString();
}

function notifyQueueUpdate(session) {
  queueStoreFor(session).changed();
}

function shortId() {
  return `q-${randomUUID()}`;
}

function terminalStatus(status) {
  return TERMINAL.has(String(status ?? '').toLowerCase());
}

export function ensureJobQueue(session) {
  return queueStoreFor(session).list();
}

export function productionLockBusy(session) {
  return sessionActivities(session).some((activity) =>
    activity.source === 'production' && !activity.terminal && activity.poll,
  );
}

export function enqueueProductionJob(session, args = {}, reason = 'waiting') {
  const workspace = session.workspace ?? null;
  const workspacePath = session.workspacePath ? resolve(session.workspacePath) : null;
  if (!workspace || !workspacePath) {
    throw new Error('Cannot enqueue production job: no active workspace path. Use /use <workspace> first.');
  }
  const normalizedArgs = normalizeProductionJobArgsForWorkspace(args, workspacePath);
  const item = {
    id: shortId(),
    workspace,
    server: 'production',
    tool: 'production_start_job',
    args: normalizedArgs,
    lockKey: `production:${workspace}`,
    status: 'waiting',
    reason,
    createdAt: now(),
  };
  ensureJobQueue(session).push(item);
  notifyQueueUpdate(session);
  return item;
}

function normalizeProductionJobArgsForWorkspace(args, workspacePath) {
  const normalized = { ...args };
  if (!Array.isArray(normalized.inputs)) return normalized;
  normalized.inputs = normalized.inputs.map((input) => normalizeWorkspaceInput(input, workspacePath));
  return normalized;
}

function normalizeWorkspaceInput(input, workspacePath) {
  const raw = String(input ?? '').trim();
  if (!raw) return raw;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw);
  const rel = relative(workspacePath, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Cannot enqueue production job: input is outside the active workspace: ${raw}`);
  }
  return rel.split(sep).join('/');
}

export function queueSummary(args = {}) {
  const parts = [
    args.type,
    Array.isArray(args.steps) && args.steps.length ? `steps=${args.steps.join(',')}` : null,
    Array.isArray(args.templates) && args.templates.length ? `templates=${args.templates.length}` : null,
    Array.isArray(args.deliverables) && args.deliverables.length ? `deliverables=${args.deliverables.length}` : null,
    args.configPath ? `config=${args.configPath}` : null,
  ].filter(Boolean);
  return parts.join(' ') || 'production job';
}

export function queueCounts(session) {
  const queue = projectQueue(session.headlessPlan, ensureJobQueue(session), { workspace: session.workspace ?? null });
  return {
    active: queue.length,
    current: queue.filter((item) => item.workspace === session.workspace || !item.workspace).length,
    frozen: queue.filter((item) => item.workspace && item.workspace !== session.workspace).length,
  };
}

export function projectQueue(plan, queue, { workspace = null } = {}) {
  const blockedJobs = (queue ?? [])
    .filter((item) => ['waiting', 'blocked', 'pending_approval'].includes(String(item.status ?? '').toLowerCase()))
    .map((item) => ({
      ...item,
      queueType: 'blocked_job',
    }));
  const pendingSteps = (plan ?? [])
    .filter((step) => step.status === 'pending')
    .map((step) => ({
      id: `plan-${step.step}`,
      queueType: 'pending_step',
      status: 'pending',
      workspace,
      step: step.step,
      activityKey: step.activityKey ?? step.ownerActivityKey ?? undefined,
      args: { type: step.description },
    }));
  return [...blockedJobs, ...pendingSteps];
}

export function formatQueue(session) {
  const queue = ensureJobQueue(session);
  if (queue.length === 0) return 'Queue is empty.';
  return queue.map((item) => {
    const frozen = item.workspace !== session.workspace && ['waiting', 'starting', 'running'].includes(item.status)
      ? ' frozen'
      : '';
    const job = item.jobId ? ` job=${item.jobId}` : '';
    const error = item.error ? ` error=${item.error}` : '';
    return `${item.id} ${item.status}${frozen} ${item.workspace ?? 'no-workspace'} ${queueSummary(item.args)}${job}${error}`;
  }).join('\n');
}

export function clearFinishedQueueItems(session) {
  const queue = ensureJobQueue(session);
  const before = queue.length;
  const next = queue.filter((item) =>
    item.workspace !== session.workspace || !terminalStatus(item.status),
  );
  queueStoreFor(session).replace(next);
  return before - next.length;
}

function findQueueItem(session, id) {
  return ensureJobQueue(session).find((item) => item.id === id) ?? null;
}

export async function cancelQueueItem(session, id) {
  const item = findQueueItem(session, id);
  if (!item) return { ok: false, message: `Unknown queue item: ${id}` };
  if (item.status === 'waiting' || item.status === 'starting') {
    const label = item.status === 'starting' ? 'starting' : 'queued';
    item.status = 'cancelled';
    item.finishedAt = now();
    notifyQueueUpdate(session);
    return { ok: true, message: `Cancelled ${label} job ${id}.` };
  }
  if (item.status === 'running') {
    if (item.server === 'production' && item.jobId) {
      await callMcpTool(session.mcp, 'production', 'production_cancel_job', { jobId: item.jobId });
      item.status = 'cancelled';
      item.finishedAt = now();
      notifyQueueUpdate(session);
      return { ok: true, message: `Cancellation requested for ${id} (${item.jobId}).` };
    }
    return { ok: false, message: `No cancel tool available for ${id}.` };
  }
  return { ok: false, message: `Queue item ${id} is already ${item.status}.` };
}

function activeCurrentWorkspaceProductionJob(session) {
  return productionLockBusy(session)
    || ensureJobQueue(session).some((item) =>
      item.workspace === session.workspace && ['starting', 'running'].includes(item.status),
    );
}

function nextWaitingProductionItem(session) {
  return ensureJobQueue(session).find((item) =>
    item.workspace === session.workspace
    && item.server === 'production'
    && item.tool === 'production_start_job'
    && item.status === 'waiting',
  ) ?? null;
}

export async function startNextQueuedJob(session, hooks = {}) {
  if (!session.workspace) return null;
  if (activeCurrentWorkspaceProductionJob(session)) return null;
  const item = nextWaitingProductionItem(session);
  if (!item) return null;

  item.status = 'starting';
  item.startedAt = now();
  notifyQueueUpdate(session);
  hooks.refresh?.();
  hooks.addLog?.(`queue: starting ${item.id} ${queueSummary(item.args)}`);

  try {
    const args = session.workspace && !item.args.callerLabel
      ? { ...item.args, callerLabel: `${session.workspace}/wiki-manager` }
      : item.args;
    item.args = args;
    const result = await callMcpTool(session.mcp, 'production', 'production_start_job', args);
    const resultText = formatMcpToolResult(result);
    const payload = parseJsonText(resultText);
    if (payload?.ok === false && payload?.error === 'workspace_busy') {
      item.status = 'waiting';
      item.reason = 'workspace_busy';
      notifyQueueUpdate(session);
      hooks.addLog?.(`queue: ${item.id} still waiting, production lock busy`);
      hooks.refresh?.();
      return item;
    }
    const activity = extractActivity(payload, { server: 'production', tool: 'production_start_job' });
    if (activity) {
      item.status = activity.terminal ? activity.status : 'running';
      item.jobId = activity.id;
      item.activityKey = activity.key;
      item.finishedAt = activity.terminal ? now() : undefined;
      notifyQueueUpdate(session);
      dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
        origin: 'queue',
        payload: { activity },
      }));
    } else {
      item.status = 'done';
      item.finishedAt = now();
      notifyQueueUpdate(session);
    }
    hooks.addLog?.(`queue: ${item.id} ${item.status}${item.jobId ? ` job=${item.jobId}` : ''}`);
    hooks.refresh?.();
    return item;
  } catch (err) {
    item.status = 'failed';
    item.error = err instanceof Error ? err.message : String(err);
    item.finishedAt = now();
    notifyQueueUpdate(session);
    hooks.addLog?.(`queue: ${item.id} failed · ${item.error}`);
    hooks.refresh?.();
    return item;
  }
}

export function syncQueueWithActivity(session, activity) {
  if (!activity?.id || activity.source !== 'production') return null;
  const item = ensureJobQueue(session).find((entry) => entry.jobId === activity.id);
  if (!item) return null;
  item.status = activity.terminal ? activity.status : 'running';
  item.activityKey = activity.key;
  item.finishedAt = activity.terminal ? now() : item.finishedAt;
  item.error = activity.error ?? item.error;
  notifyQueueUpdate(session);
  return item;
}
