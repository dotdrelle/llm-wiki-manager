import { createAgentEvent, dispatchAgentEvent, dispatchRuntimeLog } from '../core/agentEvents.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { cloneJson } from '../core/json.js';
import { assertContract } from '../contracts/schemas.js';

const AVAILABLE = 'available';
const UNAVAILABLE = 'unavailable';
/**
 * Health of an agent restored from the journal, as long as no successful
 * `agent_describe` has happened in the current process.
 *
 * Neither `available` nor `unavailable`: we do NOT know. Distinguishing it
 * from `unavailable` has a practical consequence — an unknown agent becomes
 * available again silently on the first successful scan, whereas an agent
 * declared unavailable would deserve to be reported as such to the user.
 */
const UNKNOWN = 'unknown';

/**
 * A persisted agent is not a reachable agent.
 *
 * On restart, `hydrateSession` replays the event journal and rebuilds agents
 * with the health they had WHEN the event was written. `cme-main` therefore
 * reappeared `available` while its endpoint no longer existed, was retained
 * as a provider, and the task left for an absent agent — the breakdown
 * observed on 2026-08-04.
 *
 * Persistence says what existed, not what answers now. Only a successful
 * `agent_describe` in this process authorises talking about availability.
 */
export function markPersistedAgentsStale(session) {
  if (!session || typeof session !== 'object') return [];
  const stale = (agent) => ({
    ...agent,
    health: UNKNOWN,
    stale: true,
    // The original health is kept: it tells what we knew before shutdown,
    // which helps read a journal, without ever serving routing.
    healthBeforeRestart: agent?.health ?? null,
  });
  /*
   ALL restored representations, `agentRegistrySnapshot` included.

   I first spared the snapshot, on the grounds that it could carry a live
   scan. That was backwards: at hydration, no scan has happened yet — the
   order is hydrate → invalidate → discover, and nothing runs between the
   first two. The snapshot therefore comes from the same persisted projection
   as `session.agents`. Sparing it left `cme-main` routable with its endpoint
   off, which hot validation showed.

   The only scan that matters is the next one: `discover()` rewrites the
   snapshot entirely from the successful `agent_describe` calls.
  */
  session.agents = (session.agents ?? []).map(stale);
  session.agentRegistrySnapshot = (session.agentRegistrySnapshot ?? []).map(stale);
  return session.agentRegistrySnapshot;
}

export function createAgentRegistry({
  callTool = callMcpTool,
  now = () => new Date(),
} = {}) {
  const agentsByInstance = new Map();
  const instanceByServer = new Map();
  // Whether the LAST probe of an instance failed. The "did not answer
  // agent_describe" log is edge-triggered: it is emitted once when an instance
  // stops answering, not on every re-scan while it stays down. A stopped agent
  // is not an error to repeat every minute.
  const lastProbeFailed = new Map();

  return {
    async discover(session, { signal = null } = {}) {
      const discovered = [];
      const endpoints = Object.entries(session?.mcp ?? {});
      const activeServers = new Set(endpoints.map(([serverName]) => serverName));
      // Each probe is an independent network call (agent_describe against one
      // server); none reads another server's result. Probing them concurrently
      // turns the wall-clock cost from the SUM of every server's probe latency
      // into the latency of the SLOWEST one — the sequential version made every
      // delegation get linearly slower as more MCP servers were connected.
      // registerAgent still runs afterward in the original endpoint order, one
      // at a time, so event ordering and the shared-map mutations it performs
      // are unchanged.
      const probed = await Promise.all(
        endpoints.map(([serverName, endpoint]) =>
          discoverServerAgent(session, serverName, endpoint, { callTool, signal, now })),
      );
      for (const agent of probed) {
        discovered.push(registerAgent(session, agent, { agentsByInstance, instanceByServer, lastProbeFailed }));
      }
      for (const [serverName, instanceId] of instanceByServer) {
        if (activeServers.has(serverName)) continue;
        const previous = agentsByInstance.get(instanceId);
        instanceByServer.delete(serverName);
        agentsByInstance.delete(instanceId);
        // Same cleanup as the two maps above: without it, a long-running
        // process that sees many renamed/reconnected connectors (the
        // Connectors panel supports exactly this) accumulates one stale
        // entry per retired instance for the process lifetime.
        lastProbeFailed.delete(instanceId);
        if (previous) dispatchRegistryEvent(session, 'agent.unregistered', {
          agentInstanceId: instanceId,
          serverName,
        });
      }
      session.agentRegistry = this;
      session.agentRegistrySnapshot = this.snapshot();
      return discovered;
    },
    snapshot() {
      return [...agentsByInstance.values()]
        .map((agent) => cloneAgent(agent))
        .sort((a, b) => a.agentInstanceId.localeCompare(b.agentInstanceId));
    },
    get(agentInstanceId) {
      const agent = agentsByInstance.get(String(agentInstanceId));
      return agent ? cloneAgent(agent) : null;
    },
  };
}

async function discoverServerAgent(session, serverName, endpoint = {}, { callTool, signal, now }) {
  const lastSeenAt = now().toISOString();
  if (endpoint.status !== 'connected') {
    return legacyAgent(serverName, endpoint, { health: UNAVAILABLE, lastSeenAt });
  }

  const tool = findAgentDescribeTool(serverName, endpoint.tools ?? []);
  if (!tool) {
    return legacyAgent(serverName, endpoint, { health: AVAILABLE, lastSeenAt });
  }
  const toolName = tool.name;

  try {
    const result = await callTool(
      session.mcp,
      serverName,
      toolName,
      describeArguments(tool, session?.workspace),
      signal,
    );
    const description = assertContract('agentDescription', parseToolJsonResult(result));
    return {
      serverName,
      toolName,
      agentInstanceId: description.agentInstanceId,
      description,
      health: description.health?.status ?? AVAILABLE,
      firstSeenAt: lastSeenAt,
      lastSeenAt,
      legacy: false,
      orchestrable: true,
    };
  } catch (error) {
    return legacyAgent(serverName, endpoint, {
      health: UNAVAILABLE,
      lastSeenAt,
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function registerAgent(session, agent, { agentsByInstance, instanceByServer, lastProbeFailed }) {
  const previousInstanceId = instanceByServer.get(agent.serverName);
  const previous = previousInstanceId ? agentsByInstance.get(previousInstanceId) : null;

  /*
   A failed discovery must not erase a known orchestrator agent.

   When the endpoint is transiently unreachable — the runtime boots before its
   containers (the normal boot order), or a single probe times out —
   `discoverServerAgent` falls back to a legacy agent with no capabilities. The
   old code replaced the orchestrator agent with that fallback, so every
   capability silently vanished from the registry and did not come back until a
   LATER successful discovery. Keep the orchestrator agent and only refresh its
   probe timestamp: its capabilities are still real, only the endpoint is down.
  */
  if (agent.legacy && previous && !previous.legacy) {
    agentsByInstance.set(previous.agentInstanceId, { ...previous, lastSeenAt: agent.lastSeenAt });
    /*
     Preserving is right; preserving in silence is what caused the hunt.

     Every defect this registry produced was invisible: capabilities vanished
     without an event, and the resolver could only report the consequence ("no
     agent provides X") long afterwards. Keeping the agent fixes the loss, not
     the blindness — a probe that failed is a fact worth stating, once, where
     the panels and the shell already read.

     "Once" is the operative word: the re-scan runs every minute, and a stopped
     agent is not an error to repeat each time it is scanned. The log is
     edge-triggered on the transition from answering to not answering.

     Deliberately NOT a health change: the endpoint is down but the agent stays
     usable by design here, and moving `health` would make `capabilityResolver`
     refuse it — trading a silent loss for a silent refusal.
     */
    const wasAnswering = lastProbeFailed.get(previous.agentInstanceId) !== true;
    lastProbeFailed.set(previous.agentInstanceId, true);
    if (wasAnswering) {
      dispatchRuntimeLog(session, `⚠ agent-registry: ${agent.serverName} did not answer agent_describe`
        + `${agent.error ? ` (${agent.error})` : ''}; keeping its known capabilities`
        + ` (${(previous.description?.capabilities ?? []).map((capability) => capability.id).join(', ') || 'none'}).`);
    }
    return cloneAgent(previous);
  }

  const firstSeenAt = previous?.firstSeenAt ?? agent.firstSeenAt ?? agent.lastSeenAt;
  const next = {
    ...agent,
    firstSeenAt,
  };

  if (previous && previous.agentInstanceId !== next.agentInstanceId) {
    agentsByInstance.delete(previous.agentInstanceId);
  }
  agentsByInstance.set(next.agentInstanceId, next);
  instanceByServer.set(next.serverName, next.agentInstanceId);
  if (lastProbeFailed) lastProbeFailed.set(next.agentInstanceId, false);

  if (!previous || previous.agentInstanceId !== next.agentInstanceId) {
    dispatchRegistryEvent(session, 'agent.registered', { agent: next });
  } else if (previous.health !== next.health) {
    dispatchRegistryEvent(session, 'agent.health_changed', {
      agent: next,
      agentInstanceId: next.agentInstanceId,
      previousHealth: previous.health,
      health: next.health,
    });
  }
  return cloneAgent(next);
}

function dispatchRegistryEvent(session, type, payload) {
  if (!session) return;
  dispatchAgentEvent(session, createAgentEvent(type, {
    origin: 'agent_registry',
    workspace: session.workspace ?? null,
    payload,
  }));
}

function findAgentDescribeTool(serverName, tools) {
  const named = tools.filter((tool) => String(tool?.name ?? ''));
  const byName = (predicate) => named.find((tool) => predicate(String(tool.name)));
  return byName((name) => name === 'agent_describe')
    ?? byName((name) => name === `${serverName}__agent_describe`)
    ?? byName((name) => name.endsWith('__agent_describe'))
    ?? null;
}

// Parts of a contract are workspace-scoped — typically the closed vocabulary of
// an argument (the sources declared in THIS workspace). Published as a bare
// string, such a field is unverifiable and a planner fills it with any noun
// from the objective, so it is worth telling the agent which workspace we are
// asking about.
//
// But the orchestrator must not assume an agent accepts an argument it never
// declared: an agent whose agent_describe schema is `additionalProperties:
// false` REJECTS the call, drops out of the registry, and its capabilities
// silently vanish — the objective then resolves to whatever agent is left.
// Send the workspace only to agents whose own schema says they can take it.
function describeArguments(tool, workspace) {
  if (!workspace) return {};
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object') return {};
  const declaresWorkspace = Object.hasOwn(schema.properties ?? {}, 'workspace');
  const acceptsExtra = schema.additionalProperties !== false;
  return declaresWorkspace || acceptsExtra ? { workspace: String(workspace) } : {};
}

function parseToolJsonResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && !Array.isArray(result.content)) {
    return result;
  }
  const text = formatMcpToolResult(result);
  return JSON.parse(text);
}

function legacyAgent(serverName, endpoint = {}, { health, lastSeenAt, toolName = null, error = null }) {
  const displayName = endpoint.displayName ?? serverName;
  const description = {
    contractVersion: 'legacy',
    agentType: serverName,
    agentInstanceId: `${serverName}-legacy`,
    displayName,
    capabilities: [],
    orchestration: {
      canPlan: false,
      canExpandPlan: false,
      canExecute: false,
      canCancel: false,
      canResume: false,
      supportsIdempotency: false,
      supportsParallelWorkers: false,
    },
    limits: {
      recommendedConcurrency: 0,
      maxConcurrency: 0,
    },
    health: { status: health },
  };
  return {
    serverName,
    toolName,
    agentInstanceId: description.agentInstanceId,
    description,
    health,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    legacy: true,
    orchestrable: false,
    error,
  };
}

function cloneAgent(agent) {
  return {
    ...agent,
    description: cloneJson(agent.description),
  };
}

