import { runtimeTokenFromEnv as runtimeToken } from './auth.js';

function base(url) {
  return url.replace(/\/$/, '');
}

function runtimeEndpoint(url, path, workspace = null) {
  const endpoint = new URL(`${base(url)}${path}`);
  if (workspace) endpoint.searchParams.set('workspace', workspace);
  return endpoint.toString();
}

export function runtimeUrlFromEnv() {
  return process.env.WIKI_MANAGER_RUNTIME_URL ?? 'http://127.0.0.1:7788';
}

export async function fetchRuntimeState({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/state', workspace), {
    headers: runtimeHeaders(token),
  });
  if (!response.ok) throw new Error(`Runtime state failed: HTTP ${response.status}`);
  return response.json();
}

export async function checkRuntimeHealth({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/health', workspace), {
    headers: runtimeHeaders(token),
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
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/run', workspace), {
    method: 'POST',
    headers: {
      ...runtimeHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.assign({ input, workspace }, evaluate !== undefined && { evaluate }, replans !== undefined && { replans })),
  });
  if (!response.ok) {
    const err = new Error(`Runtime run failed: HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export async function postRuntimeControl(action, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  input = undefined,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/control', workspace), {
    method: 'POST',
    headers: {
      ...runtimeHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.assign({ action }, input !== undefined && { input })),
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

export async function postRuntimeResume({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/resume', workspace), {
    method: 'POST',
    headers: runtimeHeaders(token),
  });
  if (!response.ok) throw new Error(`Runtime resume failed: HTTP ${response.status}`);
  return response.json();
}

export async function postRuntimeApprove({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
  runId = null,
  itemId = null,
  approvalId = null,
} = {}) {
  const endpoint = runtimeEndpoint(url, '/approve', workspace);
  const parsed = new URL(endpoint);
  if (runId) parsed.searchParams.set('runId', runId);
  if (itemId) parsed.searchParams.set('itemId', itemId);
  if (approvalId) parsed.searchParams.set('approvalId', approvalId);
  const response = await fetch(parsed.toString(), {
    method: 'POST',
    headers: runtimeHeaders(token),
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
} = {}) {
  const response = await fetch(runtimeEndpoint(url, '/events/stream', workspace), {
    headers: { ...runtimeHeaders(token), Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) throw new Error(`Runtime SSE connect failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
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
        try {
          yield { type, data: JSON.parse(data) };
        } catch {
          // malformed frame — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function runtimeFetchOptions(token = runtimeToken()) {
  return { headers: runtimeHeaders(token) };
}
