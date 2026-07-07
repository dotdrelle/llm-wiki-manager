import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { assertContract } from '../contracts/schemas.js';

const AVAILABLE = 'available';
const UNAVAILABLE = 'unavailable';

export function createAgentRegistry({
  callTool = callMcpTool,
  now = () => new Date(),
} = {}) {
  const agentsByInstance = new Map();
  const instanceByServer = new Map();

  return {
    async discover(session, { signal = null } = {}) {
      const discovered = [];
      for (const [serverName, endpoint] of Object.entries(session?.mcp ?? {})) {
        const agent = await discoverServerAgent(session, serverName, endpoint, { callTool, signal, now });
        discovered.push(registerAgent(session, agent, { agentsByInstance, instanceByServer }));
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

  const toolName = findAgentDescribeTool(serverName, endpoint.tools ?? []);
  if (!toolName) {
    return legacyAgent(serverName, endpoint, { health: AVAILABLE, lastSeenAt });
  }

  try {
    const result = await callTool(session.mcp, serverName, toolName, {}, signal);
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

function registerAgent(session, agent, { agentsByInstance, instanceByServer }) {
  const previousInstanceId = instanceByServer.get(agent.serverName);
  const previous = previousInstanceId ? agentsByInstance.get(previousInstanceId) : null;
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
  const names = tools.map((tool) => String(tool.name ?? '')).filter(Boolean);
  return names.find((name) => name === 'agent_describe')
    ?? names.find((name) => name === `${serverName}__agent_describe`)
    ?? names.find((name) => name.endsWith('__agent_describe'))
    ?? null;
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

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
