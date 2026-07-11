const SUPPORTED_CONTRACT_VERSIONS = new Set(['1']);

export function createCapabilityRegistry({ agents = [], compatibleContractVersions = SUPPORTED_CONTRACT_VERSIONS } = {}) {
  const compatible = compatibleContractVersions instanceof Set
    ? compatibleContractVersions
    : new Set(compatibleContractVersions);
  const providers = new Map();

  for (const agent of agents ?? []) {
    if (!isProviderAgent(agent, compatible)) continue;
    for (const capability of agent.description?.capabilities ?? []) {
      const key = capabilityKey(capability.id, capability.version);
      const entry = {
        agentInstanceId: agent.agentInstanceId,
        serverName: agent.serverName ?? null,
        agentType: agent.description.agentType,
        displayName: agent.description.displayName,
        health: agent.health,
        capability,
        description: agent.description,
        lastSeenAt: agent.lastSeenAt ?? null,
      };
      const list = providers.get(key) ?? [];
      list.push(entry);
      providers.set(key, list);
    }
  }

  return {
    providersFor(capability) {
      const { id, version } = parseCapability(capability);
      if (version) return [...(providers.get(capabilityKey(id, version)) ?? [])];
      return [...providers.entries()]
        .filter(([key]) => key.startsWith(`${id}@`))
        .flatMap(([, list]) => list);
    },
    isCompatible(contractVersion) {
      return compatible.has(String(contractVersion ?? ''));
    },
    snapshot() {
      return Object.fromEntries(
        [...providers.entries()].map(([key, list]) => [key, list.map((entry) => ({ ...entry }))]),
      );
    },
  };
}

// Discovery and registry construction are asynchronous and are not always
// completed in the same order. Consumers must nevertheless validate against
// the live discovered agents instead of treating a temporarily absent cached
// registry as an empty registry.
export function capabilityRegistryForSession(session) {
  const agents = session?.agentRegistry?.snapshot?.()
    ?? session?.agentRegistrySnapshot
    ?? session?.agents
    ?? [];
  if (agents.length > 0) return createCapabilityRegistry({ agents });
  if (session?.capabilityRegistry?.providersFor) return session.capabilityRegistry;
  return createCapabilityRegistry();
}

function isProviderAgent(agent, compatible) {
  if (!agent || agent.legacy || agent.orchestrable === false) return false;
  if (!compatible.has(String(agent.description?.contractVersion ?? ''))) return false;
  if (!['available', 'degraded'].includes(String(agent.health ?? agent.description?.health?.status ?? ''))) return false;
  return Array.isArray(agent.description?.capabilities);
}

function parseCapability(value) {
  const raw = String(value ?? '');
  const index = raw.lastIndexOf('@');
  if (index <= 0 || index === raw.length - 1) return { id: raw, version: null };
  return { id: raw.slice(0, index), version: raw.slice(index + 1) };
}

function capabilityKey(id, version) {
  return `${id}@${version}`;
}
