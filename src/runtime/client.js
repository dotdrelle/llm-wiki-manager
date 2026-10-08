import { runtimeTokenFromEnv as runtimeToken } from './auth.js';

function base(url) {
  return url.replace(/\/$/, '');
}

function runtimeEndpoint(url, path, workspace = null) {
  const endpoint = new URL(`${base(url)}${path}`);
  if (workspace) endpoint.searchParams.set('workspace', workspace);
  return endpoint.toString();
}

function runtimeEndpointWithParams(url, path, params = {}) {
  const endpoint = new URL(`${base(url)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') endpoint.searchParams.set(key, String(value));
  }
  return endpoint.toString();
}

export function runtimeUrlFromEnv() {
  return process.env.WIKI_MANAGER_RUNTIME_URL ?? 'http://127.0.0.1:7788';
}

const RUNTIME_STATE_TIMEOUT_MS = 15_000;
// The runtime writes an SSE comment every 15 s on every stream; a stream that
// stays silent this long is dead (typically after a sleep/standby) even if its
// socket still looks established, so the reader gives up and reconnects.
export const RUNTIME_STREAM_IDLE_TIMEOUT_MS = 45_000;

export async function fetchRuntimeState({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  timeoutMs = RUNTIME_STATE_TIMEOUT_MS,
} = {}) {
  // Bounded: callers guard this with an in-flight flag, so a request left
  // hanging on a socket killed by a machine sleep would block every later sync.
  const response = await fetch(runtimeEndpoint(url, '/state', workspace), {
    headers: runtimeHeaders(token),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Runtime state failed: HTTP ${response.status}`);
  return response.json();
}

export async function checkRuntimeHealth({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  signal = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/health', workspace), {
    headers: runtimeHeaders(token),
    signal,
  });
  if (!response.ok) return null;
  return response.json();
}

export async function postRuntimeRun(input, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  evaluate = undefined,
  replans = undefined,
  capabilityPlan = undefined,
  skillName = undefined,
  conversationId = undefined,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/run', workspace), {
    method: 'POST',
    headers: {
      ...runtimeHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.assign({ input, workspace }, evaluate !== undefined && { evaluate }, replans !== undefined && { replans }, capabilityPlan !== undefined && { capabilityPlan }, skillName !== undefined && { skillName }, conversationId !== undefined && { conversationId })),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error ?? payload.message ?? payload.detail;
    const err = new Error(detail
      ? `Runtime run failed: HTTP ${response.status} — ${detail}`
      : `Runtime run failed: HTTP ${response.status}`);
    err.status = response.status;
    err.code = payload.code;
    throw err;
  }
  return payload;
}

export async function postRuntimeSkill(skillName, args = {}, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  idempotencyKey = undefined,
  turnId = undefined,
  selectionKind = undefined,
  /** Skills already running above the caller, for cycle detection. */
  skillStack = undefined,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/run', workspace), {
    method: 'POST',
    headers: { ...runtimeHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: `/${skillName}`,
      workspace,
      skillName,
      skillArguments: args,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(turnId ? { turnId } : {}),
      ...(selectionKind ? { selectionKind } : {}),
      ...(Array.isArray(skillStack) && skillStack.length ? { skillStack } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Runtime skill failed: HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export async function postRuntimeTurn(input, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  mode = 'agent',
  conversationId = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/turn', workspace), {
    method: 'POST',
    headers: {
      ...runtimeHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, workspace, mode, ...(conversationId ? { conversationId } : {}) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.error ?? `Runtime turn failed: HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return payload;
}

export async function requestRuntimeMemory(path, { method = 'GET', workspace = null, body = null, url = runtimeUrlFromEnv(), token = runtimeToken() } = {}) {
  if (!String(path).startsWith('/memory/')) throw new Error('Invalid runtime memory path.');
  const response = await fetch(runtimeEndpoint(url, path, workspace), {
    method,
    headers: { ...runtimeHeaders(token), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Runtime memory request failed: HTTP ${response.status}`);
  return payload;
}

export async function postRuntimeDelegate(objective, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  conversationId = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/delegate', workspace), {
    method: 'POST',
    headers: { ...runtimeHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ objective, workspace, ...(conversationId ? { conversationId } : {}) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.error ?? `Runtime delegation failed: HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return payload;
}

export async function postRuntimeControl(action, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  input = undefined,
  intent = undefined,
  id = undefined,
  conversationId = undefined,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/control', workspace), {
    method: 'POST',
    headers: {
      ...runtimeHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.assign({ action }, input !== undefined && { input }, intent !== undefined && { intent }, id !== undefined && { id }, conversationId !== undefined && conversationId !== null && { conversationId })),
  });
  if (!response.ok) {
    const err = new Error(`Runtime control failed: HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export async function postRuntimeCancel({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/cancel', workspace), {
    method: 'POST',
    headers: runtimeHeaders(token),
  });
  if (!response.ok && response.status !== 501) throw new Error(`Runtime cancel failed: HTTP ${response.status}`);
  return response.json();
}

// Redo support: keeps the conversation entry at `index` and drops everything
// the runtime recorded after it. Returns the server's payload so a caller can
// distinguish "nothing to truncate" from "a run is still active".
export async function postRuntimeConversationTruncate(index, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/conversation/truncate', workspace), {
    method: 'POST',
    headers: { ...runtimeHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ index, ...(workspace ? { workspace } : {}) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { truncated: false, reason: payload?.reason ?? `http_${response.status}` };
  return payload;
}

export async function postRuntimeKill({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  runId = null,
  purge = false,
} = {}) {
  const response = await fetch(runtimeEndpointWithParams(url, '/kill', { workspace, runId, ...(purge ? { purge: 'true' } : {}) }), {
    method: 'POST',
    headers: runtimeHeaders(token),
  });
  if (!response.ok && response.status !== 501) throw new Error(`Runtime kill failed: HTTP ${response.status}`);
  return response.json();
}

export async function postRuntimeShutdown({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  signal = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/shutdown'), {
    method: 'POST',
    headers: runtimeHeaders(token),
    signal,
  });
  if (!response.ok) throw new Error(`Runtime shutdown failed: HTTP ${response.status}`);
  return response.json();
}

export async function postRuntimeApprove({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  runId = null,
  itemId = null,
  approvalId = null,
  scope = null,
  planRevision = null,
  approvalClasses = null,
  caller = null,
} = {}) {
  const endpoint = runtimeEndpoint(url, '/approve', workspace);
  const parsed = new URL(endpoint);
  if (runId) parsed.searchParams.set('runId', runId);
  if (itemId) parsed.searchParams.set('itemId', itemId);
  if (approvalId) parsed.searchParams.set('approvalId', approvalId);
  const response = await fetch(parsed.toString(), {
    method: 'POST',
    headers: { ...runtimeHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace,
      runId,
      itemId,
      approvalId,
      scope,
      planRevision,
      approvalClasses,
      caller,
    }),
  });
  if (!response.ok) throw new Error(`Runtime approve failed: HTTP ${response.status}`);
  return response.json();
}

function runtimeHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function* streamRuntimeEvents({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  signal = null,
  workspace = null,
  idleTimeoutMs = RUNTIME_STREAM_IDLE_TIMEOUT_MS,
} = {}) {
  const local = new AbortController();
  const forwardAbort = () => local.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let idleTimer = null;
  let idled = false;
  const armIdle = () => {
    if (!idleTimeoutMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idled = true; local.abort(); reader?.cancel().catch(() => {}); }, idleTimeoutMs);
  };
  let reader = null;
  try {
    armIdle();
    const response = await fetch(runtimeEndpoint(url, '/events/stream', workspace), {
      headers: { ...runtimeHeaders(token), Accept: 'text/event-stream' },
      signal: local.signal,
    });
    if (!response.ok) throw new Error(`Runtime SSE connect failed: HTTP ${response.status}`);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      armIdle();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        let type = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!data) continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // malformed frame — skip
        }
        // The consumer's work between frames is not stream silence.
        clearTimeout(idleTimer);
        yield { type, data: parsed };
      }
    }
    // Bun ends a cancelled read as a normal `done` rather than rejecting it.
    if (idled) throw new Error('idle');
  } catch (err) {
    if (idled) throw new Error(`Runtime SSE stream silent for ${Math.round(idleTimeoutMs / 1000)}s; reconnecting.`);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', forwardAbort);
    if (reader) {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    local.abort();
  }
}

export async function runtimeMaintenance({url,workspace,token=runtimeToken(),command,...args}) {
  const response=await fetch(runtimeEndpoint(url,'/maintenance',workspace), {
    method:command?'POST':'GET', headers:{...runtimeHeaders(token),'Content-Type':'application/json'},
    ...(command?{body:JSON.stringify({command,...args})}:{})
  });
  const result=await response.json();if(!response.ok)throw new Error(result.message??result.error??'Maintenance unavailable');return result;
}
