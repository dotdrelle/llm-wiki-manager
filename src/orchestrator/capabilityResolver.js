export class CapabilityUnavailableError extends Error {
  constructor(capability, reason, details = {}) {
    super(`Capability unavailable: ${capability} (${reason})`);
    this.name = 'CapabilityUnavailableError';
    this.capability = capability;
    this.reason = reason;
    this.details = details;
  }
}

export function resolve(capability, { workspaceConfig = {}, registry } = {}) {
  const capabilityId = capabilityName(capability);
  if (!capabilityId) throw new CapabilityUnavailableError(capability, 'missing_capability');
  if (!registry || typeof registry.providersFor !== 'function') {
    throw new CapabilityUnavailableError(capabilityId, 'missing_registry');
  }

  const allProviders = registry.providersFor(capability) ?? [];
  if (allProviders.length === 0) {
    throw new CapabilityUnavailableError(capabilityId, 'capability_not_found');
  }

  const compatible = allProviders.filter((provider) => isCompatible(provider, registry));
  if (compatible.length === 0) {
    throw new CapabilityUnavailableError(capabilityId, 'contract_incompatible', { providers: providerIds(allProviders) });
  }

  const routing = routingForCapability(workspaceConfig, capabilityId);
  const authorized = filterConfiguredAgents(compatible, routing.allowedAgents);
  if (authorized.length === 0) {
    throw new CapabilityUnavailableError(capabilityId, 'agent_not_allowed', {
      allowedAgents: routing.allowedAgents,
      providers: providerIds(compatible),
    });
  }

  const healthy = authorized.filter(isHealthy);
  if (healthy.length === 0) {
    throw new CapabilityUnavailableError(capabilityId, 'agent_unhealthy', { providers: providerIds(authorized) });
  }

  const available = healthy.filter(isAvailable);
  if (available.length === 0) {
    throw new CapabilityUnavailableError(capabilityId, 'agent_unavailable', { providers: providerIds(healthy) });
  }

  const preferred = firstConfiguredProvider(available, routing.preferredAgents);
  if (preferred) return assignment(preferred);

  if (routing.preferredAgents.length > 0) {
    const fallback = firstConfiguredProvider(available, routing.fallbackAgents);
    if (fallback) return assignment(fallback);
    throw new CapabilityUnavailableError(capabilityId, 'preferred_agent_unavailable', {
      preferredAgents: routing.preferredAgents,
      fallbackAgents: routing.fallbackAgents,
      providers: providerIds(available),
    });
  }

  const candidates = routing.fallbackAgents.length > 0
    ? filterConfiguredAgents(available, routing.fallbackAgents)
    : available;
  if (candidates.length === 0) {
    throw new CapabilityUnavailableError(capabilityId, 'fallback_agent_unavailable', {
      fallbackAgents: routing.fallbackAgents,
      providers: providerIds(available),
    });
  }

  return assignment([...candidates].sort(compareProviderScore)[0]);
}

function assignment(provider) {
  return { agentInstanceId: provider.agentInstanceId };
}

function isCompatible(provider, registry) {
  const contractVersion = provider.description?.contractVersion ?? provider.contractVersion;
  return typeof registry.isCompatible === 'function'
    ? registry.isCompatible(contractVersion)
    : String(contractVersion ?? '') === '1';
}

function routingForCapability(workspaceConfig, capabilityId) {
  const raw = workspaceConfig?.capabilityRouting?.[capabilityId] ?? {};
  return {
    preferredAgents: stringList(raw.preferredAgents),
    fallbackAgents: stringList(raw.fallbackAgents),
    allowedAgents: stringList(raw.allowedAgents),
  };
}

function filterConfiguredAgents(providers, configuredAgents) {
  if (!Array.isArray(configuredAgents) || configuredAgents.length === 0) return providers;
  const allowed = new Set(configuredAgents.map(String));
  return providers.filter((provider) => allowed.has(provider.agentInstanceId));
}

function firstConfiguredProvider(providers, configuredAgents) {
  if (!Array.isArray(configuredAgents) || configuredAgents.length === 0) return null;
  for (const agentInstanceId of configuredAgents) {
    const provider = providers.find((candidate) => candidate.agentInstanceId === agentInstanceId);
    if (provider) return provider;
  }
  return null;
}

function isHealthy(provider) {
  return ['available', 'degraded'].includes(String(provider.health ?? provider.description?.health?.status ?? ''));
}

function isAvailable(provider) {
  if (provider.available === false) return false;
  if (provider.availability === 'unavailable') return false;
  if (provider.busy === true && provider.acceptsQueuedWork === false) return false;
  return true;
}

function compareProviderScore(a, b) {
  return costScore(a) - costScore(b)
    || historyScore(b) - historyScore(a)
    || String(a.agentInstanceId).localeCompare(String(b.agentInstanceId));
}

function costScore(provider) {
  const cost = provider.capability?.estimatedCost ?? provider.estimatedCost ?? {};
  const llmCalls = Number(cost.llmCalls ?? 0);
  const tokenRange = Array.isArray(cost.tokenRange) ? cost.tokenRange : [];
  const tokenAverage = tokenRange.length >= 2 ? (Number(tokenRange[0]) + Number(tokenRange[1])) / 2 : 0;
  return (Number.isFinite(llmCalls) ? llmCalls : 0) * 100000
    + (Number.isFinite(tokenAverage) ? tokenAverage : 0);
}

function historyScore(provider) {
  const successRate = Number(provider.history?.successRate ?? provider.successRate ?? 0);
  return Number.isFinite(successRate) ? successRate : 0;
}

function providerIds(providers) {
  return providers.map((provider) => provider.agentInstanceId).filter(Boolean);
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function capabilityName(value) {
  const raw = String(value ?? '').trim();
  const index = raw.lastIndexOf('@');
  return index > 0 ? raw.slice(0, index) : raw;
}
