export async function resolveObjective(objective, session) {
  const candidates = capabilityCandidates(session);
  if (candidates.length === 0) throw new Error('No orchestrable capability is currently available.');
  const llm = session?.llm;
  if (!llm?.completeWithTools) throw new Error('Objective resolution requires the configured workspace LLM.');

  const result = await llm.completeWithTools({
    system: [
      'You resolve one user objective against a closed capability registry.',
      'Select exactly one listed capability and one of its supported operations.',
      'Never invent identifiers. Return JSON only: {"capability":"...","operation":"..."}.',
    ].join('\n'),
    tools: [],
    messages: [{
      role: 'user',
      content: `Objective:\n${String(objective)}\n\nRegistry:\n${JSON.stringify(candidates, null, 2)}`,
    }],
    signal: session?._abortSignal,
  });
  const selection = parseJson(result?.content);
  const capability = String(selection?.capability ?? '');
  const operation = String(selection?.operation ?? '');
  const candidate = candidates.find((item) => item.id === capability);
  if (!candidate) throw new Error(`Objective resolver selected unknown capability "${capability}".`);
  if (!candidate.operations.includes(operation)) {
    throw new Error(`Objective resolver selected unsupported operation "${operation}" for ${capability}.`);
  }
  const providers = providersFor(session, capability)
    .filter((provider) => !operation || (provider.capability?.supportedOperations ?? []).includes(operation))
    .sort((a, b) => String(a.agentInstanceId).localeCompare(String(b.agentInstanceId)));
  if (providers.length === 0) throw new Error(`No healthy agent provides ${capability}/${operation}.`);
  return { capability, operation, provider: providers[0], candidates };
}

export function capabilityCandidates(session) {
  const snapshot = registrySnapshot(session);
  const byId = new Map();
  for (const [versionedId, providers] of Object.entries(snapshot)) {
    const id = versionedId.includes('@') ? versionedId.slice(0, versionedId.lastIndexOf('@')) : versionedId;
    const operations = [...new Set((providers ?? []).flatMap((provider) => provider?.capability?.supportedOperations ?? []))].sort();
    const description = (providers ?? []).map((provider) => provider?.capability?.description).find(Boolean) ?? '';
    byId.set(id, { id, description, operations });
  }
  return [...byId.values()].filter((item) => item.operations.length > 0).sort((a, b) => a.id.localeCompare(b.id));
}

function providersFor(session, capability) {
  if (session?.capabilityRegistry?.providersFor) return session.capabilityRegistry.providersFor(capability) ?? [];
  return Object.entries(registrySnapshot(session))
    .filter(([key]) => key === capability || key.startsWith(`${capability}@`))
    .flatMap(([, providers]) => providers ?? []);
}

function registrySnapshot(session) {
  const registry = session?.capabilityRegistry;
  if (registry?.snapshot) return registry.snapshot();
  if (registry && typeof registry === 'object') return registry;
  const agents = session?.agentRegistry?.snapshot?.() ?? session?.agentRegistrySnapshot ?? [];
  const snapshot = {};
  for (const agent of agents) {
    for (const capability of agent?.description?.capabilities ?? []) {
      const key = `${capability.id}@${capability.version ?? '1'}`;
      (snapshot[key] ??= []).push({
        agentInstanceId: agent.agentInstanceId,
        serverName: agent.serverName,
        capability,
        description: agent.description,
        health: agent.health,
      });
    }
  }
  return snapshot;
}

function parseJson(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}
