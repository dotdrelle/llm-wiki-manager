import { runtimeTokenFromEnv as runtimeToken } from './auth.js';

function base(url) {
  return url.replace(/\/$/, '');
}

export function runtimeUrlFromEnv() {
  return process.env.WIKI_MANAGER_RUNTIME_URL ?? 'http://127.0.0.1:7788';
}

export async function fetchRuntimeState({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
} = {}) {
  const response = await fetch(`${base(url)}/state`, {
    headers: runtimeHeaders(token),
  });
  if (!response.ok) throw new Error(`Runtime state failed: HTTP ${response.status}`);
  return response.json();
}

export async function checkRuntimeHealth({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
} = {}) {
  const response = await fetch(`${base(url)}/health`, {
    headers: runtimeHeaders(token),
  });
  if (!response.ok) return null;
  return response.json();
}

export async function postRuntimeRun(input, {
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  workspace = null,
} = {}) {
  const response = await fetch(`${base(url)}/run`, {
    method: 'POST',
    headers: {
      ...runtimeHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, workspace }),
  });
  if (!response.ok) throw new Error(`Runtime run failed: HTTP ${response.status}`);
  return response.json();
}

export async function postRuntimeCancel({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
} = {}) {
  const response = await fetch(`${base(url)}/cancel`, {
    method: 'POST',
    headers: runtimeHeaders(token),
  });
  if (!response.ok && response.status !== 501) throw new Error(`Runtime cancel failed: HTTP ${response.status}`);
  return response.json();
}

function runtimeHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function* streamRuntimeEvents({
  url = runtimeUrlFromEnv(),
  token = runtimeToken(),
  signal = null,
} = {}) {
  const response = await fetch(`${base(url)}/events/stream`, {
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
