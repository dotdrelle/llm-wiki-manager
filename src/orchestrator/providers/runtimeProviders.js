import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchRuntimeLog } from '../../core/agentEvents.js';
import { managerEnvFile, managerStateDir, readEnvFile } from '../../core/env.js';
import { createDeepAgentsProvider } from './deepAgentsProvider.js';
import { createFakeRuntimeProvider } from './fakeRuntimeProvider.js';
import { assertRuntimeProvider } from './runtimeProvider.js';

/**
 * Découverte des runtimes agentiques externes et projection en « agents »
 * synthétiques, afin que leurs capabilities entrent dans le même
 * `CapabilityRegistry` que les agents MCP (RFC § 10, niveau B).
 *
 * Un runtime down ne produit AUCUN agent : ses capabilities sont simplement
 * absentes du registry, et la résolution échoue en `capability_not_found`
 * sans jamais toucher aux capabilities MCP existantes (isolation de panne,
 * RFC § 39). Le runtime défaillant est néanmoins signalé via la liste
 * `unavailable` retournée — une dégradation doit s'annoncer.
 */

export async function discoverRuntimeProviderAgents(runtimeProviders) {
  const providers = Array.isArray(runtimeProviders)
    ? runtimeProviders
    : (runtimeProviders?.list?.() ?? []);
  const agents = [];
  const unavailable = [];

  for (const entry of providers) {
    const provider = entry?.provider ?? entry;
    const runtimeId = String(entry?.id ?? provider?.runtime ?? 'external-runtime');
    let description;
    try {
      assertRuntimeProvider(provider);
      description = await provider.describe();
    } catch (error) {
      unavailable.push({ runtimeId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (description?.health === 'unavailable') {
      unavailable.push({ runtimeId, error: description?.error ?? 'runtime reports unavailable' });
      continue;
    }
    let capabilities;
    try {
      capabilities = await provider.discoverCapabilities();
    } catch (error) {
      unavailable.push({ runtimeId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const health = ['available', 'degraded'].includes(description?.health)
      ? description.health
      : 'available';
    for (const capability of capabilities ?? []) {
      agents.push(runtimeProviderAgent(runtimeId, provider, description, capability, health));
    }
  }

  return { agents, unavailable };
}

/**
 * Configuration `agentRuntimes` (RFC § 37), fichier `agent-runtimes.json` dans
 * le répertoire d'état du manager. Deux formes tolérées : un tableau nu, ou un
 * objet `{ "runtimes": [...] }`. Absent ou illisible ⇒ aucune runtime déclarée.
 *
 * Entrée : `{ id, type, endpoint?, enabled?, capabilities?, limits? }`.
 */
export function loadAgentRuntimesConfig({
  stateDir = managerStateDir(),
  log = () => {},
  env = null,
} = {}) {
  // GATEWAY_ENABLED / GATEWAY_AUTH_TOKEN live in the manager .env FILE, not in
  // the process environment (the runtime child is spawned without them). The
  // manager's canonical policy is the same as resolvedManagerEnv: the file
  // wins over stale process values, so a token generated later by `agents up`
  // is honoured without a restart.
  const resolvedEnv = env ?? (() => {
    try {
      return { ...process.env, ...readEnvFile(managerEnvFile()) };
    } catch {
      return process.env;
    }
  })();
  const file = join(stateDir, 'agent-runtimes.json');
  let entries = [];
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      entries = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.runtimes ?? [] : []);
    } catch (error) {
      log(`agent-runtimes.json unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return withImpliedGateway(entries, resolvedEnv, log);
}

// One switch: when the operator starts the gateway container
// (GATEWAY_ENABLED=true in the manager .env), the manager implies the runtime
// declaration itself — if it starts, it is usable. agent-runtimes.json stays
// for the exceptional cases: a custom endpoint, pinned capabilities, or
// another engine (fake). An explicit ENABLED deepagents entry wins over the
// implied one; a disabled entry does not block it — but that override is a
// case worth stating, not assuming: an operator who wrote `enabled: false`
// deliberately would otherwise have no way to learn why deepagents ran anyway.
function withImpliedGateway(entries, env = process.env, log = () => {}) {
  const token = String(env.GATEWAY_AUTH_TOKEN ?? '').trim();
  const gatewayPort = String(env.GATEWAY_PORT ?? '7789');
  if (isTruthy(env.GATEWAY_ENABLED) && token) {
    // The manager owns THIS gateway (host-local, GATEWAY_PORT): its bearer
    // token must reach the EXPLICIT entry too. The scaffolded
    // agent-runtimes.json declares the capabilities but no headers, so
    // discovery probed /health without the token and the gateway answered 401
    // forever — "enabled by default" plus "explicit entry" must not combine
    // into a permanently unavailable runtime. An operator who pinned explicit
    // headers keeps them; a `deepagents` entry pointing at a foreign or shared
    // host gets NOTHING — the local gateway secret must never leave the box.
    for (const entry of entries) {
      if (entry?.type !== 'deepagents' || entry?.enabled === false) continue;
      if (!isManagerOwnedGatewayEndpoint(entry.endpoint, gatewayPort)) continue;
      const headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : {};
      if ('Authorization' in headers || 'authorization' in headers) continue;
      entry.headers = { ...headers, Authorization: `Bearer ${token}` };
    }
  }
  if (!isTruthy(env.GATEWAY_ENABLED)) return entries;
  const explicitEnabled = entries.some((entry) =>
    entry?.type === 'deepagents' && entry?.enabled !== false);
  if (explicitEnabled) return entries;
  const disabledEntry = entries.find((entry) => entry?.type === 'deepagents' && entry?.enabled === false);
  if (disabledEntry) {
    log('agent-runtimes: GATEWAY_ENABLED=true implies a "deepagents" runtime despite an explicit enabled:false entry in agent-runtimes.json');
  }
  const port = gatewayPort;
  // The implied entry inherits the disabled entry's declared capability shape
  // (approval classes, alias operations, descriptions): the scaffolded
  // agent-runtimes.json ships the full list with enabled:false, and dropping it
  // here would let a gateway /capabilities response that omits
  // defaultRequiresApproval/mutationClass turn a mutating capability into a
  // self-approving one. The endpoint stays host-local (the manager runtime runs
  // on the host, not in the agents network) and the env token still wins.
  const inheritedCapabilities = Array.isArray(disabledEntry?.capabilities) && disabledEntry.capabilities.length > 0
    ? { capabilities: disabledEntry.capabilities }
    : {};
  const inheritedHeaders = disabledEntry?.headers && typeof disabledEntry.headers === 'object'
    ? disabledEntry.headers
    : {};
  return [
    ...entries.filter((entry) => entry !== disabledEntry),
    {
      ...(disabledEntry?.timeoutMs ? { timeoutMs: disabledEntry.timeoutMs } : {}),
      ...inheritedCapabilities,
      id: 'deepagents',
      type: 'deepagents',
      endpoint: `http://localhost:${port}`,
      enabled: true,
      ...(token
        ? { headers: { ...inheritedHeaders, Authorization: `Bearer ${token}` } }
        : (Object.keys(inheritedHeaders).length > 0 ? { headers: inheritedHeaders } : {})),
    },
  ];
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

// The manager-owned gateway is the one the manager itself starts: host-local,
// on GATEWAY_PORT. An entry with no endpoint relies on the implied host-local
// one, so it counts too. Anything else — a shared or third-party gateway host
// an operator pointed a second `deepagents` entry at — must not be handed the
// manager's local GATEWAY_AUTH_TOKEN.
function isManagerOwnedGatewayEndpoint(endpoint, gatewayPort) {
  if (!endpoint) return true;
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    return false;
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);
  if (!localHosts.has(url.hostname)) return false;
  const entryPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  return entryPort === String(gatewayPort);
}

/**
 * Usines de providers par `type`. `fake` sert les tests/plomberie ; `deepagents`
 * parle HTTP à un runtime externe (Phase 5). Un type inconnu est ignoré et
 * signalé — jamais une erreur fatale au démarrage.
 */
export const runtimeProviderFactories = {
  fake: (entry = {}) => createFakeRuntimeProvider({
    runtime: String(entry?.id ?? 'fake'),
    capabilities: Array.isArray(entry?.capabilities) && entry.capabilities.length > 0
      ? entry.capabilities
      : undefined,
    ...(entry?.available === false ? { available: false } : {}),
    ...(entry?.proposal && typeof entry.proposal === 'object' ? { proposal: entry.proposal } : {}),
  }),
  deepagents: (entry = {}) => createDeepAgentsProvider({
    id: String(entry?.id ?? 'deepagents'),
    endpoint: String(entry?.endpoint ?? 'http://agent-runtime:7789'),
    capabilities: Array.isArray(entry?.capabilities) && entry.capabilities.length > 0
      ? entry.capabilities
      : null,
    ...(entry?.headers && typeof entry.headers === 'object' ? { headers: entry.headers } : {}),
    ...(entry?.timeoutMs ? { timeoutMs: Number(entry.timeoutMs) } : {}),
  }),
};

export function resolveRuntimeProviders(config = [], { factories = runtimeProviderFactories } = {}) {
  const providers = [];
  const skipped = [];
  for (const entry of Array.isArray(config) ? config : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;
    const id = String(entry?.id ?? entry?.type ?? '');
    const type = String(entry?.type ?? '');
    const factory = factories?.[type];
    if (typeof factory !== 'function') {
      skipped.push({ id, reason: `unknown runtime type "${type}"` });
      continue;
    }
    try {
      const provider = factory(entry);
      assertRuntimeProvider(provider);
      providers.push({ id, type, provider });
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { providers, skipped };
}

/**
 * Hook de découverte : peuple `session.runtimeProviderAgents` à partir de la
 * config, et signale les runtimes sautées/indisponibles dans le journal
 * (une dégradation doit s'annoncer). Appelée au boot et à chaque re-scan,
 * en vis-à-vis de `discoverAgentsOnce`.
 */
export async function discoverRuntimeProvidersOnce(session, {
  signal = null,
  config = null,
} = {}) {
  if (!session || typeof session !== 'object') return [];
  void signal;
  let impliedGatewayOverride = false;
  const entries = config ?? loadAgentRuntimesConfig({
    log: (message) => {
      if (String(message).startsWith('agent-runtimes: GATEWAY_ENABLED=true implies')) impliedGatewayOverride = true;
    },
  });
  const resolved = resolveRuntimeProviders(entries);
  const { agents, unavailable } = await discoverRuntimeProviderAgents(resolved.providers);

  // A failed probe is not a lost agent (same rule as agentRegistry): a runtime
  // that reported unavailable this round but for which we hold a last-known-good
  // capability set keeps that set until it recovers, instead of every `agent.*`
  // capability vanishing from the registry on a transient network blip. Health
  // is deliberately not downgraded — capabilityResolver only accepts
  // available/degraded, so moving it to unavailable would trade a silent loss
  // for a silent refusal. A runtime that answers is authoritative, even when it
  // answers with zero capabilities (a real removal); a runtime no longer
  // configured is forgotten.
  session._runtimeProviderLastKnown ??= new Map();
  const lastKnown = session._runtimeProviderLastKnown;
  const configuredIds = new Set(resolved.providers.map((entry) => String(entry?.id ?? entry?.provider?.runtime ?? 'external-runtime')));
  const unavailableIds = new Set(unavailable.map((item) => item.runtimeId));
  const answeredIds = new Set(agents.map((agent) => agent.runtimeId));
  for (const id of configuredIds) {
    if (unavailableIds.has(id) && !answeredIds.has(id)) continue; // preserved below
    const fresh = agents.filter((agent) => agent.runtimeId === id);
    if (fresh.length > 0) lastKnown.set(id, fresh);
    else lastKnown.delete(id);
  }
  for (const id of [...lastKnown.keys()]) {
    if (!configuredIds.has(id)) lastKnown.delete(id);
  }
  const preservedByRuntime = new Map();
  for (const item of unavailable) {
    if (answeredIds.has(item.runtimeId)) continue;
    const kept = lastKnown.get(item.runtimeId);
    if (kept && kept.length > 0) preservedByRuntime.set(item.runtimeId, kept);
  }
  const effectiveAgents = [...agents];
  for (const kept of preservedByRuntime.values()) effectiveAgents.push(...kept);
  session.runtimeProviderAgents = effectiveAgents;
  // A degradation is announced ONCE, on the transition to down/skipped — not
  // on every periodic re-scan. The agent registry learned this the hard way: a
  // stopped endpoint is a fact to state, not an error to repeat every minute.
  // The set is edge-triggered and forgotten as soon as the runtime recovers,
  // so a future outage is announced again.
  if (impliedGatewayOverride && !session._gatewayOverrideAnnounced) {
    dispatchRuntimeLog(session, 'agent-runtimes: GATEWAY_ENABLED=true implies a "deepagents" runtime despite an explicit enabled:false entry in agent-runtimes.json');
  }
  session._gatewayOverrideAnnounced = impliedGatewayOverride;
  session._runtimeProviderDown ??= new Set();
  const currentDown = new Set();
  for (const item of resolved.skipped) {
    const key = `skipped:${item.id || '(unnamed)'}`;
    currentDown.add(key);
    if (!session._runtimeProviderDown.has(key)) {
      dispatchRuntimeLog(session, `agent-runtimes: ${item.id || '(unnamed)'} skipped (${item.reason})`);
    }
  }
  for (const item of unavailable) {
    const key = `unavailable:${item.runtimeId}`;
    currentDown.add(key);
    if (!session._runtimeProviderDown.has(key)) {
      const kept = preservedByRuntime.get(item.runtimeId)?.length ?? 0;
      dispatchRuntimeLog(session, kept > 0
        ? `agent-runtimes: ${item.runtimeId} unavailable (${item.error}) — keeping ${kept} last-known capabilit${kept === 1 ? 'y' : 'ies'} until it recovers`
        : `agent-runtimes: ${item.runtimeId} unavailable (${item.error})`);
    }
  }
  session._runtimeProviderDown = currentDown;
  return effectiveAgents;
}

function runtimeProviderAgent(runtimeId, provider, description, capability, health) {
  const name = String(capability?.name ?? '');
  const operations = Array.isArray(capability?.operations)
    ? capability.operations.map(String).filter(Boolean)
    : [];
  const agentInstanceId = `${runtimeId}::${name}`;
  return {
    agentInstanceId,
    serverName: null,
    legacy: false,
    orchestrable: true,
    health,
    providerKind: 'external-runtime',
    runtimeId,
    runtimeProvider: provider,
    lastSeenAt: new Date().toISOString(),
    description: {
      contractVersion: '1',
      agentType: 'external-runtime',
      agentInstanceId,
      displayName: `${runtimeId} (${name})`,
      capabilities: [{
        id: name,
        version: '1',
        description: String(capability?.description ?? `${runtimeId}/${name}`),
        inputSchema: {},
        outputSchema: {},
        supportedOperations: operations.length > 0 ? operations : ['run'],
        aliases: Array.isArray(capability?.aliases) ? capability.aliases.map(String).filter(Boolean) : [],
        aliasOperations: capability?.aliasOperations && typeof capability.aliasOperations === 'object'
          ? { ...capability.aliasOperations }
          : null,
        // Without these, an external-runtime capability can never be seen as
        // mutating by isMutatingTask/buildExecutorOnlyFragment, so a task
        // that should wait for a human grant starts unapproved by construction.
        ...(typeof capability?.mutationClass === 'string' ? { mutationClass: capability.mutationClass } : {}),
        ...(capability?.defaultRequiresApproval === true ? { defaultRequiresApproval: true } : {}),
      }],
      orchestration: {
        canPlan: false,
        canExpandPlan: false,
        canExecute: true,
        canCancel: true,
        canResume: false,
        supportsIdempotency: false,
        supportsParallelWorkers: true,
        singleTaskOnly: true,
      },
      limits: {
        recommendedConcurrency: Number(description?.limits?.recommendedConcurrency ?? 4),
        maxConcurrency: Number(description?.limits?.maxConcurrency ?? 8),
      },
      health: { status: health },
    },
  };
}
