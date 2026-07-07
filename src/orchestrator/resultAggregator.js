import { validateContract } from '../contracts/schemas.js';
import { parseJsonText } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { resolve as resolveCapability } from './capabilityResolver.js';
import { integrate } from './planIntegrator.js';
import { validateFragment } from './planValidator.js';

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

  const effectiveRegistry = registry ?? session.capabilityRegistry;
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
  return result?.ok === true || ['succeeded', 'success', 'done', 'complete', 'completed'].includes(status);
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

function agentPlanRequest(request, session) {
  return {
    capability: request.capability,
    operation: request.operation ?? undefined,
    objective: request.objective ?? request.reason ?? undefined,
    workspace: request.workspace ?? workspaceRequest(session),
    arguments: request.arguments && typeof request.arguments === 'object' ? request.arguments : {},
    constraints: request.constraints && typeof request.constraints === 'object' ? request.constraints : {},
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
