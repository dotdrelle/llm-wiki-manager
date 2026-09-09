import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateContract } from '../contracts/schemas.js';
import { parseJsonText } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { capabilityRegistryForSession } from './capabilityRegistry.js';
import { resolve as resolveCapability } from './capabilityResolver.js';
import { integrate } from './planIntegrator.js';
import { validateFragment } from './planValidator.js';
import { isSuccessful } from './taskStatuses.js';

export function createResultAggregator({
  session = null,
  runId = null,
  store = null,
  registry = null,
  workspaceConfig = null,
  budgets = {},
  callTool = callMcpTool,
} = {}) {
  return {
    accept(result, options = {}) {
      return accept(result, {
        session,
        runId,
        store,
        registry,
        workspaceConfig,
        budgets,
        callTool,
        ...options,
      });
    },
  };
}

export async function accept(result, {
  session,
  runId = null,
  task = null,
  assignment = null,
  store = null,
  registry = null,
  workspaceConfig = null,
  budgets = {},
  callTool = callMcpTool,
} = {}) {
  if (!session) throw new Error('resultAggregator.accept requires session.');
  const taskId = String(result?.taskId ?? task?.id ?? task?.step ?? '');
  const ok = resultOk(result);
  const status = cancelled(result) ? 'cancelled' : ok ? 'done' : 'failed';
  const payload = {
    runId,
    taskId,
    result,
    assignment: assignment ? {
      agentInstanceId: assignment.agentInstanceId,
      serverName: assignment.serverName ?? null,
    } : null,
  };
  persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('task.result_returned', {
    origin: 'result_aggregator',
    runId,
    taskId,
    payload,
  })));
  // A worktree proposal is a review item, not a log line: persist it into the
  // workspace review queue (.wiki/agent-proposals/) where the served review
  // surface reads it, and announce it — a proposal nobody is told about is a
  // proposal nobody merges, and a merge is the approval.
  const worktreePersisted = persistWorktreeProposal(session, result, { runId, taskId, ok, status });
  if (worktreePersisted.error) {
    persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('runtime_log', {
      origin: 'result_aggregator',
      runId,
      taskId,
      payload: { message: `agent-proposal: could not persist the worktree proposal for ${taskId}: ${worktreePersisted.error}` },
    })));
  } else if (worktreePersisted.path) {
    persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('runtime_log', {
      origin: 'result_aggregator',
      runId,
      taskId,
      payload: { message: `agent-proposal: ${taskId} is waiting for review — ${worktreePersisted.path}` },
    })));
  }
  persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
    origin: 'result_aggregator',
    runId,
    taskId,
    payload: {
      taskId,
      status,
      outputRefs: normalizeOutputRefs(result?.outputRefs ?? result?.result?.outputRefs),
      result,
    },
  })));
  persistDispatch(store, dispatchAgentEvent(session, createAgentEvent(ok ? 'task.completed' : 'task.failed', {
    origin: 'result_aggregator',
    runId,
    taskId,
    payload,
  })));
  const expansion = await maybeExpandPlan(result, {
    session,
    runId,
    task,
    taskId,
    store,
    registry,
    workspaceConfig,
    budgets,
    callTool,
  });
  return { ok, status, expansion };
}

async function maybeExpandPlan(result, {
  session,
  runId,
  task,
  taskId,
  store,
  registry,
  workspaceConfig,
  budgets,
  callTool,
}) {
  const request = result?.planExpansionRequest ?? result?.result?.planExpansionRequest;
  if (!request) return null;

  const requestValidation = validateContract('planExpansionRequest', request);
  if (!requestValidation.ok) {
    return rejectExpansion({ session, runId, taskId, store, errors: requestValidation.errors.map((message) => ({ code: 'invalid_plan_expansion_request', message })) });
  }

  // session.capabilityRegistry is never assigned anywhere in production;
  // falling back to it here meant every planExpansionRequest resolved
  // against `undefined` and was unconditionally rejected as
  // capability_unavailable, regardless of whether the capability existed.
  const effectiveRegistry = registry ?? capabilityRegistryForSession(session);
  let resolved;
  try {
    resolved = resolveCapability(request.capability, {
      workspaceConfig: workspaceConfig ?? session.wikircConfig ?? session.wikirc?.config ?? {},
      registry: effectiveRegistry,
    });
  } catch (err) {
    return rejectExpansion({
      session,
      runId,
      taskId,
      store,
      errors: [{
        code: 'capability_unavailable',
        message: err instanceof Error ? err.message : String(err),
        details: {
          capability: request.capability,
          reason: err?.reason ?? null,
        },
      }],
    });
  }

  const provider = providerFor(effectiveRegistry, request.capability, resolved.agentInstanceId);
  const serverName = provider?.serverName ?? agentFor(session, resolved.agentInstanceId)?.serverName ?? null;
  if (!serverName) {
    return rejectExpansion({
      session,
      runId,
      taskId,
      store,
      errors: [{ code: 'agent_server_unavailable', message: `No MCP server found for expansion agent ${resolved.agentInstanceId}.` }],
    });
  }

  const toolName = toolNameFor(session, serverName, 'agent_plan');
  const planRequest = agentPlanRequest(request, session);
  const fragment = parseToolPayload(await callTool(session.mcp, serverName, toolName, planRequest));
  // A planner that REFUSES answers { ok: false, error } (the production agent
  // does, e.g. "knowledge.update cannot plan operation: doctor"). Feeding that
  // envelope to validateFragment turned the planner's actual sentence into
  // contract noise ("taskGraphFragment.ok is not allowed") — the human saw a
  // schema violation instead of the reason. Surface the planner's words.
  if (fragment && typeof fragment === 'object' && !Array.isArray(fragment) && fragment.ok === false) {
    return rejectExpansion({
      session,
      runId,
      taskId,
      store,
      errors: [{
        code: 'planner_rejected',
        message: String(fragment.error ?? 'the planner rejected the objective without a reason'),
        details: { capability: request.capability, operation: request.operation ?? null },
      }],
    });
  }
  const validation = validateFragment(fragment, {
    registry: effectiveRegistry,
    run: { plannerAgentInstanceId: resolved.agentInstanceId },
    budgets,
  });
  if (!validation.ok) {
    return rejectExpansion({ session, runId, taskId, store, errors: validation.errors });
  }

  return integrate(runId, validation.normalizedFragment, {
    registry: effectiveRegistry,
    budgets,
    session,
    store,
    workspace: session.workspace ?? session._currentRunIdentity?.workspace ?? null,
    insertBeforeTasks: request.insertBeforeTasks ?? [],
    insertAfterTasks: request.insertAfterTasks ?? (taskId ? [taskId] : []),
    enforceApprovalCoverage: true,
  });
}

function rejectExpansion({ session, runId, taskId, store, errors }) {
  const event = dispatchAgentEvent(session, createAgentEvent('plan.rejected', {
    origin: 'result_aggregator',
    runId,
    taskId,
    payload: {
      runId,
      taskId,
      errors,
    },
  }));
  persistDispatch(store, event);
  return { ok: false, errors };
}

function resultOk(result) {
  const status = String(result?.status ?? result?.result?.status ?? '').toLowerCase();
  return result?.ok === true || isSuccessful(status);
}

function cancelled(result) {
  return ['cancelled', 'canceled'].includes(String(result?.status ?? result?.result?.status ?? '').toLowerCase());
}

function normalizeOutputRefs(value) {
  return Array.isArray(value) ? value.map((ref) => (ref && typeof ref === 'object' ? { ...ref } : String(ref))) : [];
}

function persistDispatch(store, event) {
  store?.persistEvent?.(event);
}

/**
 * Worktree proposals (agent.curate): the external runtime's run result carries
 * `worktreeProposal` — the confined branch's changed files, their new content
 * and the unified diff. The manager writes it into the workspace review queue
 * (`.wiki/agent-proposals/<id>.json`, gitignored state) where the served
 * review surface reads it; the MERGE happens there, through the engine's own
 * write machinery — this function only records, it never touches wiki content.
 */
function persistWorktreeProposal(session, result, { runId, taskId }) {
  const proposal = result?.result?.worktreeProposal ?? result?.worktreeProposal;
  if (!proposal || typeof proposal !== 'object') return { path: null };
  const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
  if (changes.length === 0) return { path: null };
  const workspacePath = session?.workspacePath;
  if (!workspacePath || typeof workspacePath !== 'string') {
    return { error: 'no workspace path on the session — the proposal stays in the run result only' };
  }
  const record = {
    id: String(taskId),
    runId: String(runId ?? ''),
    workspace: String(proposal.workspace ?? session.workspace ?? ''),
    branch: String(proposal.branch ?? ''),
    worktreePath: String(proposal.worktreePath ?? ''),
    worktreeRelativePath: String(proposal.worktreeRelativePath ?? ''),
    createdAt: new Date().toISOString(),
    justification: String(proposal.justification ?? ''),
    ...(Array.isArray(proposal.objections) && proposal.objections.length > 0
      ? { objections: proposal.objections }
      : {}),
    changedFiles: Array.isArray(proposal.changedFiles) ? proposal.changedFiles : [],
    changes,
    diff: String(proposal.diff ?? ''),
  };
  try {
    const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = join(workspacePath, '.wiki', 'agent-proposals');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safeId}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2));
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function agentPlanRequest(request, session) {
  return {
    capability: request.capability,
    operation: request.operation ?? undefined,
    objective: request.objective ?? request.reason ?? undefined,
    workspace: request.workspace ?? workspaceRequest(session),
    arguments: request.arguments && typeof request.arguments === 'object' ? request.arguments : {},
    constraints: {
      ...(request.constraints && typeof request.constraints === 'object' ? request.constraints : {}),
      // Default governance, same as prepareDelegation: mutations wait for a
      // human grant. Omitting it here let the planner answer mutating tasks
      // with requiresApproval:false — the scheduler dispatched an ingest
      // plan with no gate, and the production agent's confirmation guard
      // then rejected every job ("requires confirm=true").
      // requireApprovalForMutations: false from the proposal itself remains
      // an explicit opt-out (a runtime declaring its own policy).
      requireApprovalForMutations: request.constraints?.requireApprovalForMutations !== false,
    },
  };
}

function workspaceRequest(session) {
  const workspace = session.workspace ?? session._currentRunIdentity?.workspace;
  if (workspace && typeof workspace === 'object' && !Array.isArray(workspace)) return { ...workspace };
  return { name: String(workspace ?? 'workspace') };
}

function providerFor(registry, capability, agentInstanceId) {
  if (typeof registry?.providersFor !== 'function') return null;
  return (registry.providersFor(capability) ?? [])
    .find((provider) => provider.agentInstanceId === agentInstanceId) ?? null;
}

function agentFor(session, agentInstanceId) {
  return [
    ...(session?.agentRegistrySnapshot ?? []),
    ...(session?.agents ?? []),
  ].find((agent) => agent?.agentInstanceId === agentInstanceId) ?? null;
}

function toolNameFor(session, serverName, baseName) {
  const tools = session.mcp?.[serverName]?.tools ?? [];
  const names = tools.map((tool) => String(tool.name ?? '')).filter(Boolean);
  return names.find((name) => name === baseName)
    ?? names.find((name) => name === `${serverName}__${baseName}`)
    ?? names.find((name) => name.endsWith(`__${baseName}`))
    ?? baseName;
}

function parseToolPayload(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && !Array.isArray(result.content)) return result;
  return parseJsonText(formatMcpToolResult(result)) ?? {};
}
