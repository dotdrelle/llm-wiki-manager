import { createCapabilityRegistry } from './capabilityRegistry.js';
import { CapabilityUnavailableError, resolve } from './capabilityResolver.js';

export function createAssignmentManager({
  session = null,
  registry = null,
  workspaceConfig = null,
} = {}) {
  return {
    assign(task, options = {}) {
      return assign(task, {
        session,
        registry,
        workspaceConfig,
        ...options,
      });
    },
  };
}

export async function assign(task, {
  session = null,
  registry = null,
  workspaceConfig = null,
} = {}) {
  const capability = task?.requiredCapability;
  if (!capability) {
    throw new CapabilityUnavailableError(capability, 'task_missing_required_capability', { taskId: task?.id ?? task?.step });
  }
  const effectiveRegistry = registry ?? session?.capabilityRegistry ?? createCapabilityRegistry({
    agents: session?.agentRegistrySnapshot ?? session?.agents ?? [],
  });
  const effectiveWorkspaceConfig = workspaceConfig ?? session?.wikircConfig ?? session?.wikirc?.config ?? {};
  const retryAssignment = task?.retryAssignment;
  if (retryAssignment?.agentInstanceId) {
    const provider = providerFor(effectiveRegistry, capability, retryAssignment.agentInstanceId);
    if (!provider) {
      throw new CapabilityUnavailableError(capability, 'retry_agent_unavailable', {
        agentInstanceId: retryAssignment.agentInstanceId,
        taskId: task?.id ?? task?.step,
      });
    }
    const agent = agentFor(session, retryAssignment.agentInstanceId) ?? provider;
    return {
      agentInstanceId: retryAssignment.agentInstanceId,
      capability,
      operation: task?.operation ?? null,
      serverName: agent?.serverName ?? provider?.serverName ?? null,
      agent,
      retry: true,
      previousAgentInstanceId: retryAssignment.previousAgentInstanceId ?? null,
    };
  }
  const resolved = resolve(capability, {
    workspaceConfig: effectiveWorkspaceConfig,
    registry: effectiveRegistry,
  });
  const provider = providerFor(effectiveRegistry, capability, resolved.agentInstanceId);
  const agent = agentFor(session, resolved.agentInstanceId) ?? provider ?? null;
  return {
    ...resolved,
    capability,
    operation: task?.operation ?? null,
    serverName: agent?.serverName ?? provider?.serverName ?? null,
    agent,
  };
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
