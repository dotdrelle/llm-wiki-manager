import { existsSync, readFileSync } from 'node:fs';
import { managerEnvFile, managerMcpEndpointsFile, readEnvFile } from './env.js';

const WIKI_MANAGER_VERSION = '0.15.70';

function envValue(key) {
  const filePath = managerEnvFile();
  if (existsSync(filePath)) {
    const fileValue = readEnvFile(filePath)[key];
    if (fileValue !== undefined) return fileValue;
  }
  return process.env[key];
}

function interpolateEnv(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const sep = expr.indexOf(':-');
    if (sep !== -1) return envValue(expr.slice(0, sep)) ?? expr.slice(sep + 2);
    return envValue(expr) ?? '';
  });
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key, value]) => key && typeof value === 'string' && value)
      .map(([key, value]) => [key.toLowerCase(), interpolateEnv(value)]),
  );
}

// An endpoint's url/headers may reference `${VAR}` placeholders with no
// `:-default`. If that env var is unset, the placeholder interpolates to ''
// (see interpolateEnv) and the endpoint would otherwise look "configured"
// with a blank credential — then discoverMcpTools happily probes the live
// endpoint and can report it "connected" even though it has no real auth.
function hasMissingRequiredEnv(value) {
  if (typeof value !== 'string') return false;
  let missing = false;
  value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const sep = expr.indexOf(':-');
    if (sep === -1 && !envValue(expr)) missing = true;
    return '';
  });
  return missing;
}

function endpointHasMissingCredentials(endpoint) {
  const headerValues = Object.values(endpoint?.headers ?? {}).filter((value) => typeof value === 'string');
  return [String(endpoint?.url ?? ''), ...headerValues].some(hasMissingRequiredEnv);
}

function normalizeExternalUrlForRuntime(url) {
  if (process.env.WIKI_MANAGER_KEEP_DOCKER_HOST === '1') return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'host.docker.internal') {
      parsed.hostname = 'localhost';
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

// Config-driven policy for the /chat toolset — NOT /agent, which has the full
// toolset and ignores this. The endpoints file's "chatAccess" block declares,
// per server, which tools /chat may call ("*" or a list), plus a
// maxToolIterations budget. Every server uses the SAME shape: one `allow` key.
// Operator-owned, agnostic allow-list. Returns null when not configured — then
// /chat stays a plain, tool-less conversation.
//
// `allowActions` is a legacy key from the connectors work: it carved out a
// second list for tools the read-verb heuristic rejected, which made one
// server's entry shaped differently from every other. It is folded into
// `allow` on read so existing installs keep working without regenerating
// their endpoints file, but nothing writes it any more.
// The packaged example and every scaffolded mcp.endpoints.json declare the
// two built-in workspace servers' chatAccess under their public/documented
// names ("llm-wiki", "wiki-production" — see PROTECTED_SERVERS in
// mcpEndpoints.js and the root CLAUDE.md). Those servers are actually
// discovered into session.mcp under different internal keys ("wiki",
// "production" — MCP_SERVICE_MAP below). Without this alias, chatAllowedTools'
// intersection of session.mcp against chatAccess.servers never matches the
// built-in servers, so /chat silently gets zero wiki/production tools no
// matter what is configured — alias both spellings onto the internal key.
const BUILTIN_CHAT_ACCESS_ALIASES = { 'llm-wiki': 'wiki', 'wiki-production': 'production' };

export function readChatAccessConfig() {
  const filePath = managerMcpEndpointsFile();
  if (!existsSync(filePath)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
  const chatAccess = raw?.chatAccess;
  if (!chatAccess || typeof chatAccess !== 'object' || Array.isArray(chatAccess)) return null;
  const servers = {};
  for (const [rawName, entry] of Object.entries(chatAccess.servers ?? {})) {
    const name = BUILTIN_CHAT_ACCESS_ALIASES[rawName] ?? rawName;
    // "*" is also commonly written as a one-element array (["*"]) since every
    // other "allow" example in this config is an array of tool names — treat
    // both forms as the same wildcard rather than silently allowing nothing.
    const legacyActions = Array.isArray(entry?.allowActions)
      ? entry.allowActions.map(String).filter(Boolean)
      : [];
    const isWildcard = entry?.allow === '*' || (Array.isArray(entry?.allow) && entry.allow.length === 1 && entry.allow[0] === '*');
    const priorAllow = servers[name]?.allow;
    if (isWildcard || priorAllow === '*') {
      servers[name] = { allow: '*' };
    } else if (Array.isArray(entry?.allow) || legacyActions.length > 0) {
      const merged = [...(Array.isArray(priorAllow) ? priorAllow : []), ...(Array.isArray(entry?.allow) ? entry.allow.map(String).filter(Boolean) : []), ...legacyActions];
      servers[name] = { allow: [...new Set(merged)] };
    }
  }
  const maxToolIterations = Number.isFinite(Number(chatAccess.maxToolIterations)) && Number(chatAccess.maxToolIterations) > 0
    ? Math.floor(Number(chatAccess.maxToolIterations))
    : null;
  return { maxToolIterations, servers };
}

function readExternalMcpEndpoints() {
  const filePath = managerMcpEndpointsFile();
  if (!existsSync(filePath)) return {};
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const servers = raw?.mcpServers ?? raw?.servers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return Object.fromEntries(
    Object.entries(servers)
      .filter(([, endpoint]) => endpoint?.url)
      .map(([name, endpoint]) => {
        const missingCredentials = endpointHasMissingCredentials(endpoint);
        return [
          name,
          {
            ...endpointStatus(!missingCredentials, missingCredentials ? 'credential not set' : ''),
            url: normalizeExternalUrlForRuntime(interpolateEnv(String(endpoint.url))),
            configuredUrl: interpolateEnv(String(endpoint.url)),
            headers: normalizeHeaders(endpoint.headers),
            // Tools the endpoint marks approval-gated: Donna may still call them
            // directly (they are single-step tools), but toolRequiresApproval
            // makes the call wait for the user's confirmation first (e.g. a
            // destructive cme_export_run). Agent/operator owned — no hard-coded
            // business name in the manager.
            requireApproval: Array.isArray(endpoint.requireApproval)
              ? endpoint.requireApproval.map(String).filter(Boolean)
              : undefined,
            external: true,
          },
        ];
      }),
  );
}

function endpointStatus(configured, detail = '') {
  return {
    status: configured ? 'configured' : 'missing',
    detail,
  };
}

function approvalToolsFor(serverName) {
  const raw = envValue('WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS');
  if (!raw) return undefined;
  const tools = String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item === '*' || item.startsWith(`${serverName}.`) || !item.includes('.'))
    .map((item) => item.startsWith(`${serverName}.`) ? item.slice(serverName.length + 1) : item);
  return tools.length > 0 ? tools : undefined;
}

const MCP_SERVICE_MAP = {
  wiki: 'mcp-http',
  production: 'production-mcp',
};

const DEFAULT_MCP_RETRY_POLICY = {
  maxAttempts: 2,
  backoffMs: 500,
};

// MCP control traffic has its own budget. It must never consume or reduce the
// provider RPM configured in .wikirc, which is reserved for LLM/vector calls.
// Keep a little headroom below the commonly deployed 50 RPM MCP limit for
// initialize/list-tools and other non-tool-call requests.
const DEFAULT_MCP_REQUESTS_PER_MINUTE = 45;
const mcpThrottleQueues = new Map();
const mcpThrottleStarts = new Map();

export function buildMcpStatus(session) {
  // Attach the /chat read-tool policy to the session alongside MCP status.
  // Only /chat (repl.js) reads session.chatAccess; /agent ignores it.
  if (session) session.chatAccess = readChatAccessConfig();
  const workspaceEnv = session.workspaceEnv ?? {};
  const wikiMcpToken = session.wikircConfig?.mcp?.accessKey;
  const wikiMcpDetail = workspaceEnv.WIKI_MCP_PORT
    ? (wikiMcpToken ? `:${workspaceEnv.WIKI_MCP_PORT}` : `:${workspaceEnv.WIKI_MCP_PORT} (mcp.accessKey missing in active wikirc)`)
    : '';
  const external = readExternalMcpEndpoints();

  return {
    wiki: {
      ...endpointStatus(
        workspaceEnv.WIKI_MCP_PORT && wikiMcpToken,
        wikiMcpDetail,
      ),
      url: workspaceEnv.WIKI_MCP_PORT ? `http://127.0.0.1:${workspaceEnv.WIKI_MCP_PORT}/mcp` : null,
      token: wikiMcpToken || null,
      requireApproval: approvalToolsFor('wiki'),
    },
    production: {
      ...endpointStatus(
        workspaceEnv.PRODUCTION_MCP_PORT && workspaceEnv.PRODUCTION_MCP_AUTH_TOKEN,
        workspaceEnv.PRODUCTION_MCP_PORT ? `:${workspaceEnv.PRODUCTION_MCP_PORT}` : '',
      ),
      url: workspaceEnv.PRODUCTION_MCP_PORT ? `http://127.0.0.1:${workspaceEnv.PRODUCTION_MCP_PORT}/mcp/` : null,
      token: workspaceEnv.PRODUCTION_MCP_AUTH_TOKEN || null,
      activeConfigPath: session.wikirc?.fileName || null,
      requireApproval: approvalToolsFor('production'),
    },
    ...external,
  };
}

export function applyMcpRuntimeStatus(mcpStatus, serviceStates = {}) {
  const next = {};
  for (const [name, value] of Object.entries(mcpStatus ?? {})) {
    const service = MCP_SERVICE_MAP[name];
    if (!service || value.status === 'missing') {
      next[name] = value;
      continue;
    }
    const runtime = serviceStates[service];
    next[name] = {
      ...value,
      status: runtime?.running ? 'connected' : 'configured',
      runtime: runtime?.state || 'not running',
    };
  }
  return next;
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  if (dataLines.length > 0) {
    const data = dataLines.join('\n');
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(trimmed);
}

function compactDescription(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 420 ? `${text.slice(0, 417)}...` : text;
}

function clarifyToolDescription(_serverName, _toolName, description) {
  // Agnostic by design: the orchestrator does NOT inject per-agent knowledge
  // here. Tool meaning — including disambiguation like "this export publishes a
  // wiki deliverable, not a Confluence source export" — must live in each
  // agent's own MCP tool description, so any operator (our orchestrator or a
  // third-party host such as Claude) gets the same self-sufficient contract.
  // We only normalize whitespace; we never rewrite what the agent published.
  return compactDescription(description ?? '');
}

async function listMcpTools(endpoint) {
  if (!endpoint.url) throw new Error('missing endpoint URL');
  const payload = await mcpRequest(endpoint, 'tools/list', {});
  return payload?.result?.tools ?? [];
}

// Streamable HTTP sessions are server-memory state that outlives the endpoint
// objects: buildMcpStatus() rebuilds those from the endpoints file on every
// refresh, so a session cached on the object itself would be thrown away and
// re-negotiated on each call. Key the cache by transport identity (URL + the
// credentials actually presented) so a token rotation or a URL change never
// reuses a session negotiated under the previous identity.
// Values are promises, not ids: several tool calls to the same agent can race
// on a cold endpoint, and one handshake must serve them all instead of opening
// (and leaking) a session per caller.
const mcpSessions = new Map();

function sessionKey(endpoint) {
  return JSON.stringify([
    endpoint.url,
    endpoint.token ?? null,
    Object.entries(endpoint.headers ?? {}).sort(),
  ]);
}

// The MCP Streamable HTTP spec makes `initialize` mandatory before any other
// request, and a stateful server is entitled to reject a cold `tools/list`.
// Servers word that rejection however their SDK likes — "No valid session"
// (Node SDK), "Missing session ID" (Python SDK), "Session not found" — so we
// never parse the prose. We negotiate the session up front and, if the server
// later revokes it, we re-negotiate on any 400/404 and replay once.
function openMcpSession(endpoint, key, requestSignal, headersFor) {
  const pending = negotiateMcpSession(endpoint, requestSignal, headersFor);
  // Cache the promise immediately so a concurrent caller joins this handshake.
  // Drop it on failure, otherwise every later call would replay the rejection.
  mcpSessions.set(key, pending);
  pending.catch(() => {
    if (mcpSessions.get(key) === pending) mcpSessions.delete(key);
  });
  return pending;
}

async function negotiateMcpSession(endpoint, requestSignal, headersFor) {
  const response = await fetch(endpoint.url, {
    method: 'POST',
    signal: requestSignal,
    headers: headersFor(null),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'wiki-manager', version: WIKI_MANAGER_VERSION },
      },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`initialize failed: ${response.status} ${text.slice(0, 160)}`.trim());
  }
  // A stateless server completes `initialize` without issuing a session id and
  // then serves every later request unsessioned. That is valid: remember the
  // absence so we do not re-handshake before each call.
  const sessionId = response.headers.get('mcp-session-id') ?? null;
  if (sessionId) {
    // Notification, not a request: the server owes no response, and blocking
    // the caller on it would add a round-trip to every cold start.
    fetch(endpoint.url, {
      method: 'POST',
      headers: headersFor(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    }).catch(() => {});
  }
  return sessionId;
}

async function mcpRequest(endpoint, method, params, signal, options = {}) {
  if (!endpoint.url) throw new Error('missing endpoint URL');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const key = sessionKey(endpoint);

  const headersFor = (sessionId) => {
    const h = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(endpoint.headers ?? {}),
    };
    if (endpoint.token) h.authorization = `Bearer ${endpoint.token}`;
    if (sessionId) h['mcp-session-id'] = sessionId;
    return h;
  };

  const doRequest = async (sessionId) => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      signal: requestSignal,
      headers: headersFor(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    // Some servers rotate the session id mid-stream; always take the latest.
    const sid = response.headers.get('mcp-session-id');
    if (sid && sid !== sessionId) mcpSessions.set(key, Promise.resolve(sid));
    return response;
  };

  try {
    const session = mcpSessions.get(key)
      ?? openMcpSession(endpoint, key, requestSignal, headersFor);
    let response = await doRequest(await session);
    let text = await response.text();

    // The session is server-memory state: an agent restart drops it, and the
    // server answers 400 or 404 depending on its SDK. Re-negotiate and replay
    // once, without inspecting the message.
    if (response.status === 400 || response.status === 404) {
      mcpSessions.delete(key);
      const sessionId = await openMcpSession(endpoint, key, requestSignal, headersFor);
      response = await doRequest(sessionId);
      text = await response.text();
    }

    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 160)}`.trim());
    const payload = parseMcpResponse(text);
    if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callMcpTool(mcpStatus, serverName, toolName, args = {}, signal, options = {}) {
  const endpoint = mcpStatus?.[serverName];
  if (!endpoint) throw new Error(`Unknown MCP: ${serverName}`);
  if (endpoint.status !== 'connected') throw new Error(`MCP is not connected: ${serverName}`);
  const shouldInjectConfigPath =
    serverName === 'production' &&
    toolName === 'production_start_job' &&
    endpoint.activeConfigPath &&
    !args.configPath;
  const toolArgs = {
    ...args,
    ...(shouldInjectConfigPath ? { configPath: endpoint.activeConfigPath } : {}),
  };
  const timeoutMs = serverName === 'documents' && toolName === 'documents_convert_to_markdown' ? 600_000 : 8000;
  const retry = resolveRetryPolicy(endpoint, toolName, options.retry);
  return withRetry(async () => {
    await throttleMcpRequestStart(endpoint, signal);
    const payload = await mcpRequest(endpoint, 'tools/call', {
      name: toolName,
      arguments: toolArgs,
    }, signal, { timeoutMs });
    if (payload?.result?.isError) {
      throw new Error(formatMcpToolResult(payload.result));
    }
    return payload?.result ?? null;
  }, retry, { signal, onRetry: options.onRetry });
}

async function throttleMcpRequestStart(endpoint, signal) {
  const configured = Number(
    endpoint.requestsPerMinute
      ?? endpoint.rateLimit?.requestsPerMinute
      ?? envValue('WIKI_MANAGER_MCP_REQUESTS_PER_MINUTE'),
  );
  const requestsPerMinute = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MCP_REQUESTS_PER_MINUTE;
  const configuredWindowMs = Number(envValue('WIKI_MANAGER_MCP_RATE_LIMIT_WINDOW_MS'));
  const windowMs = Number.isFinite(configuredWindowMs) && configuredWindowMs > 0
    ? configuredWindowMs
    : 60_000;
  const key = String(endpoint.url ?? endpoint.name ?? 'mcp');
  const previous = mcpThrottleQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('MCP request aborted.');
      const now = Date.now();
      const starts = (mcpThrottleStarts.get(key) ?? []).filter((at) => now - at < windowMs);
      if (starts.length < requestsPerMinute) {
        starts.push(now);
        mcpThrottleStarts.set(key, starts);
        return;
      }
      await retryDelay(Math.max(1, windowMs - (now - starts[0])), signal);
    }
  });
  mcpThrottleQueues.set(key, next);
  try {
    await next;
  } finally {
    if (mcpThrottleQueues.get(key) === next) mcpThrottleQueues.delete(key);
  }
}

export function resetMcpThrottleForTests() {
  mcpThrottleQueues.clear();
  mcpThrottleStarts.clear();
}

export function resetMcpSessionsForTests() {
  mcpSessions.clear();
}

export function formatMcpToolResult(result) {
  if (!result) return 'No result.';
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result, null, 2);
  return content
    .map((item) => {
      if (item.type === 'text') return item.text ?? '';
      return JSON.stringify(item, null, 2);
    })
    .filter(Boolean)
    .join('\n\n')
    .trim() || 'No result.';
}

const DEFAULT_TOOL_RESULT_MAX_CHARS = 16000;

function toolResultMaxChars() {
  return DEFAULT_TOOL_RESULT_MAX_CHARS;
}

// Bound what a tool result injects into the LLM context and the conversation
// display. Apply this ONLY at those two exit points — never before payload
// parsing (extractActivity/_activity detection needs the full text).
// Head + tail are kept because errors and job ids often live at either end.
export function truncateToolResult(text, maxChars = toolResultMaxChars()) {
  const full = String(text ?? '');
  if (full.length <= maxChars) return full;
  const headLength = Math.floor(maxChars * 0.7);
  const tailLength = Math.floor(maxChars * 0.2);
  const omitted = full.length - headLength - tailLength;
  return `${full.slice(0, headLength)}\n\n[… ${omitted} caractères tronqués — résultat complet dans les logs runtime …]\n\n${full.slice(-tailLength)}`;
}

let _cachedEnvRetryPolicy = null;
function getEnvRetryPolicy() {
  if (!_cachedEnvRetryPolicy) {
    _cachedEnvRetryPolicy = {
      maxAttempts: numberFromEnv('WIKI_MANAGER_MCP_RETRY_MAX_ATTEMPTS')
        ?? numberFromEnv('WIKI_MANAGER_MCP_RETRY_ATTEMPTS')
        ?? DEFAULT_MCP_RETRY_POLICY.maxAttempts,
      backoffMs: numberFromEnv('WIKI_MANAGER_MCP_RETRY_BACKOFF_MS')
        ?? DEFAULT_MCP_RETRY_POLICY.backoffMs,
    };
  }
  return _cachedEnvRetryPolicy;
}

export function resolveRetryPolicy(endpoint = {}, toolName = null, override = null) {
  const toolPolicy = toolName ? endpoint.toolRetries?.[toolName] : null;
  return normalizeRetryPolicy(getEnvRetryPolicy(), endpoint.retry, toolPolicy, override);
}

function normalizeRetryPolicy(...policies) {
  const merged = {};
  for (const policy of policies) {
    if (policy === false) {
      merged.maxAttempts = 1;
      continue;
    }
    if (!policy || typeof policy !== 'object') continue;
    if (policy.maxAttempts != null) merged.maxAttempts = Number(policy.maxAttempts);
    if (policy.backoffMs != null) merged.backoffMs = Number(policy.backoffMs);
  }
  const maxAttempts = Number.isFinite(merged.maxAttempts)
    ? Math.max(1, Math.floor(merged.maxAttempts))
    : DEFAULT_MCP_RETRY_POLICY.maxAttempts;
  const backoffMs = Number.isFinite(merged.backoffMs)
    ? Math.max(0, Math.floor(merged.backoffMs))
    : DEFAULT_MCP_RETRY_POLICY.backoffMs;
  return { maxAttempts, backoffMs };
}

function numberFromEnv(key) {
  const raw = envValue(key);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function withRetry(operation, policy, { signal = null, onRetry = null } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation({ attempt });
    } catch (err) {
      lastError = err;
      if (attempt >= policy.maxAttempts || signal?.aborted) throw err;
      onRetry?.({ attempt, maxAttempts: policy.maxAttempts, error: err });
      await retryDelay(policy.backoffMs * (2 ** (attempt - 1)), signal);
    }
  }
  throw lastError;
}

function retryDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('Operation aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function discoverMcpTools(mcpStatus, previous = null) {
  const next = {};
  await Promise.all(Object.entries(mcpStatus ?? {}).map(async ([name, value]) => {
    if (value.status === 'missing') {
      next[name] = value;
      return;
    }
    try {
      const tools = await listMcpTools(value);
      next[name] = {
        ...value,
        status: 'connected',
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
        toolError: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A transient probe failure during a background re-scan must not degrade
      // a live endpoint. Docker service state (applyMcpRuntimeStatus) is the
      // authority on whether the container is up; this probe is only a tool
      // refresh, so keep last-known-good status and tools instead of flipping
      // an in-flight run's endpoint to "not connected".
      const prior = previous?.[name];
      const freshlyConnected = value.status === 'connected';
      const keepConnected = freshlyConnected || prior?.status === 'connected';
      // `degraded` marks the case Docker itself no longer confirms as
      // connected (freshlyConnected is false) and only prior history keeps
      // this endpoint reporting "connected" — the preservation this whole
      // branch exists for, worth surfacing rather than masking indefinitely.
      // `refreshMcpRuntimeStatus` (slash.js) owns the edge-triggered log, by
      // comparing this flag against the previous cycle's.
      next[name] = {
        ...value,
        status: keepConnected ? 'connected' : value.status,
        tools: keepConnected ? (prior?.tools ?? []) : [],
        toolError: message,
        degraded: keepConnected && !freshlyConnected,
      };
    }
  }));
  return next;
}

export function formatMcpTools(mcpStatus, filterName = null) {
  const lines = [];
  const entries = Object.entries(mcpStatus ?? {}).filter(([name]) => !filterName || name === filterName);
  for (const [name, value] of entries) {
    if (value.status !== 'connected') continue;
    const tools = value.tools ?? [];
    lines.push(`### ${name}`, '');
    if (tools.length === 0) {
      lines.push('No tools discovered.', '');
      continue;
    }
    for (const tool of tools.slice(0, 20)) {
      lines.push(`**Tool:** \`${tool.name}\``);
      lines.push(`**Description:** ${compactDescription(tool.description ?? '') || '-'}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    if (tools.length > 20) {
      lines.push(`_${tools.length - 20} more tools hidden._`, '');
    }
  }
  if (lines.length > 0) return lines.join('\n').trimEnd();
  return filterName
    ? `No connected MCP tools discovered for ${filterName}.`
    : 'No connected MCP tools discovered.';
}

export function formatMcpToolSummary(mcpStatus) {
  const lines = [];
  for (const [name, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    const count = value.tools?.length ?? 0;
    lines.push(`- ${name}: ${count} tool${count === 1 ? '' : 's'}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'No connected MCP tools discovered.';
}

export function formatMcpToolsForAgent(mcpStatus, { include } = {}) {
  const sections = [];
  for (const [name, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    const allTools = value.tools ?? [];
    if (allTools.length === 0) {
      sections.push(`${name}: connected, tools not discovered yet`);
      continue;
    }
    // Optional filter: callers (e.g. the interactive prompt) advertise only
    // the tools Donna is actually allowed to call, so a capable model is not
    // tempted to invoke a mutating provider tool directly instead of delegating.
    const tools = typeof include === 'function'
      ? allTools.filter((tool) => include(`${name}__${tool.name}`, tool, name))
      : allTools;
    if (tools.length === 0) continue;
    // Always advertise the qualified call name (server__tool): showing bare
    // tool names here is what teaches the model to emit unqualified calls.
    sections.push(`${name}: ${tools.map((tool) => `${name}__${tool.name}`).join(', ')}`);
  }
  // An agent that failed its probe is otherwise invisible here, and the model
  // fills the silence by inferring the agent was never set up — it then asks
  // the user for credentials that already exist. Name the agent, name the
  // transport failure, and state explicitly that this says nothing about its
  // configuration.
  const unreachable = Object.entries(mcpStatus ?? {})
    .filter(([, value]) => value.status !== 'connected' && value.toolError)
    .map(([name, value]) => `${name} (${compactDescription(value.toolError)})`);
  if (unreachable.length > 0) {
    sections.push(
      '',
      `Unreachable right now: ${unreachable.join(', ')}.`,
      'These agents are declared and may well be configured and running — the manager'
      + ' simply failed to reach them. Report the connection failure as such; never'
      + ' infer that such an agent is unconfigured, and never ask the user for its'
      + ' credentials or URL on that basis.',
    );
  }
  return sections.length > 0 ? sections.join('\n') : 'No connected MCP tools discovered yet.';
}

export function buildLlmTools(mcpStatus) {
  const tools = [];
  for (const [serverName, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    for (const tool of value.tools ?? []) {
      tools.push({
        type: 'function',
        readOnly: tool.annotations?.readOnlyHint === true,
        function: {
          name: `${serverName}__${tool.name}`,
          description: clarifyToolDescription(serverName, tool.name, tool.description),
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return tools;
}

export function parseToolCallName(name) {
  const sep = name.indexOf('__');
  if (sep === -1) return { server: null, tool: name };
  return { server: name.slice(0, sep), tool: name.slice(sep + 2) };
}

// Deterministic recovery for unqualified tool-call names emitted by the LLM
// (e.g. "cme_status" instead of "cme__cme_status"). Exact-name match only:
// if exactly one connected server (or extra pseudo-server) exposes the bare
// tool name, route to it and report `normalized: true`; otherwise return
// `server: null` with the list of candidate servers so the caller can raise
// an explicit error. This is name normalization, never fuzzy matching — do
// not extend it to description/similarity-based selection (plan directeur
// §20 forbids that).
export function resolveToolCallName(mcpStatus, name, extraServers = {}) {
  const parsed = parseToolCallName(name);
  if (parsed.server) return { ...parsed, normalized: false, candidates: [] };
  const candidates = [];
  for (const [serverName, toolNames] of Object.entries(extraServers)) {
    if (toolNames.includes(parsed.tool)) candidates.push(serverName);
  }
  for (const [serverName, value] of Object.entries(mcpStatus ?? {})) {
    if (value.status !== 'connected') continue;
    if ((value.tools ?? []).some((tool) => tool.name === parsed.tool)) candidates.push(serverName);
  }
  if (candidates.length === 1) {
    return { server: candidates[0], tool: parsed.tool, normalized: true, candidates };
  }
  return { server: null, tool: parsed.tool, normalized: false, candidates };
}

export function mcpStatusMarker(status) {
  if (status === 'connected') return '●';
  if (status === 'configured') return '◐';
  return '○';
}

export function formatMcpStatus(mcpStatus) {
  const entries = Object.entries(mcpStatus ?? {});
  if (entries.length === 0) return '○ none';
  return entries
    .map(([name, value]) => {
      const marker = mcpStatusMarker(value.status);
      const detail = [value.status, value.detail, value.runtime ? `(${value.runtime})` : '']
        .filter(Boolean)
        .join(' ');
      const tools = value.tools ? ` tools=${value.tools.length}` : '';
      const error = value.toolError ? ` toolsError=${value.toolError}` : '';
      return `${marker} ${name}${detail ? ` ${detail}` : ''}${tools}${error}`;
    })
    .join('\n');
}
