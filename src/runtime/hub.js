import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { listWorkspaces as listWorkspacesFromRegistry } from '../core/workspaces.js';

/*
 The public workspace page, served by the runtime on its own port (8080 by
 default). Like the MCP connector's landing page, it is a door, not a room: it
 answers without a token and carries only what a visitor standing in front of
 the machine may know — workspace names, whether their `serve` container runs,
 and a link to the ones that do. Never a path, a run, an agent, a token or any
 wiki content.

 Container state comes from `docker ps` (one call for every workspace). When
 Docker cannot answer, the page says so and falls back to a TCP probe of the
 serve port, so a running workspace is still reachable instead of silently
 vanishing from the list.
 */

const DOCKER_TIMEOUT_MS = 4000;
const PROBE_TIMEOUT_MS = 1200;
const MANAGER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Same rule as `compose_project` in wiki-workspace. */
export function composeProjectName(workspaceName) {
  return `wiki-${workspaceName}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** `{ ok, states: Map<project, {state, status}>, error }` — never throws. */
export function readServeStates({ execFileFn = execFile, timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFileFn(
      'docker',
      ['ps', '--filter', 'label=com.docker.compose.service=serve', '--format', '{{.Label "com.docker.compose.project"}}\t{{.State}}\t{{.Status}}'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const message = error.code === 'ENOENT'
            ? 'docker is not available on the manager host'
            : error.killed
              ? `docker ps did not answer within ${timeoutMs} ms`
              : String(error.message ?? error);
          resolve({ ok: false, states: new Map(), error: message });
          return;
        }
        const states = new Map();
        for (const line of String(stdout ?? '').split('\n')) {
          const [project, state, ...rest] = line.split('\t');
          if (!project) continue;
          states.set(project, { state: String(state ?? ''), status: rest.join('\t') });
        }
        resolve({ ok: true, states, error: null });
      },
    );
  });
}

async function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function hostnameForLinks(request) {
  const raw = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '')
    .split(',')[0]
    .trim();
  if (!raw) return 'localhost';
  try {
    return new URL(`http://${raw}`).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

function linkFor(hostname, port) {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}/`;
}

function stateLabel(state) {
  const normalized = String(state ?? '').toLowerCase();
  if (normalized === 'running') return 'Running';
  if (normalized === 'restarting') return 'Restarting';
  if (normalized === 'created') return 'Created';
  if (normalized === 'paused') return 'Paused';
  if (normalized === 'exited' || normalized === 'dead' || normalized === 'removing') return 'Stopped';
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Unknown';
}

function workspaceRows({ workspaces, states, probed, requestHost }) {
  return workspaces
    .map((workspace) => {
      const env = workspace.env ?? {};
      const servePort = Number(env.WIKI_SERVE_PORT) || null;
      const container = states.get(composeProjectName(workspace.name)) ?? null;
      const running = probed ? probed.get(workspace.name) === true : container?.state === 'running';
      return {
        name: workspace.name,
        running,
        state: probed ? (running ? 'running' : 'exited') : (container?.state ?? 'exited'),
        detail: probed ? (running ? 'answers on its port' : '') : (container?.status ?? ''),
        servePort,
        url: running && servePort ? linkFor(requestHost, servePort) : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function hubPageHtml({ rows = [], dockerError = null, workspaceCount = 0 } = {}) {
  const body = rows.length
    ? rows.map((row) => `<li class="ws${row.running ? ' running' : ''}">
        <span class="dot${row.running ? ' ok' : ''}" aria-hidden="true"></span>
        <span class="ws-name">${escapeHtml(row.name)}</span>
        <span class="ws-state"${row.detail ? ` title="${escapeHtml(row.detail)}"` : ''}>${escapeHtml(stateLabel(row.state))}</span>
        <span class="ws-port">${row.servePort ? `:${escapeHtml(row.servePort)}` : ''}</span>
        ${row.url
          ? `<a class="ws-open" href="${escapeHtml(row.url)}">Open</a>`
          : '<span class="ws-open off">Not running</span>'}
      </li>`).join('')
    : `<li class="empty">${workspaceCount
      ? 'Workspaces are configured, but none could be read.'
      : 'No workspace configured on this manager. Create one with <code>wiki-workspace config &lt;name&gt;</code>.'}</li>`;
  const warning = dockerError
    ? `<p class="warning">Container state unavailable — ${escapeHtml(dockerError)}. Status is read from the serve port instead.</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>wikiLLM — workspaces</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f5f7; --fg: #1c1f26; --muted: #6b7280; --card: #fff; --line: #d9dce3; --accent: #2563eb; --ok: #16a34a; --warn: #d97706; }
  @media (prefers-color-scheme: dark) { :root { --bg: #12141a; --fg: #e7e9ee; --muted: #9aa1ad; --card: #1b1e26; --line: #333843; } }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  .wrap { max-width: 820px; margin: 0 auto; padding: 2rem 1rem 1.5rem; min-height: 100vh; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: .55rem; margin-bottom: 1.6rem; }
  .brand-mark { width: 2rem; height: 2rem; border-radius: 8px; background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; }
  .brand-name { font-weight: 700; font-size: 1.05rem; }
  .brand-tag { color: var(--muted); font-size: .85rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .4rem; letter-spacing: -.01em; }
  .lead { color: var(--muted); font-size: .95rem; line-height: 1.5; margin: 0 0 1.4rem; max-width: 40rem; }
  .warning { border: 1px solid var(--warn); border-radius: 8px; padding: .6rem .8rem; font-size: .82rem; margin: 0 0 1rem; }
  ul { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  li { display: flex; align-items: center; gap: .8rem; padding: .85rem 1rem; border-top: 1px solid var(--line); font-size: .9rem; }
  li:first-child { border-top: 0; }
  .dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--line); flex-shrink: 0; }
  .dot.ok { background: var(--ok); }
  .ws-name { font-weight: 700; min-width: 8rem; overflow-wrap: anywhere; }
  .ws-state { color: var(--muted); min-width: 6.5rem; }
  li.running .ws-state { color: var(--fg); }
  .ws-port { color: var(--muted); font-family: ui-monospace, monospace; font-size: .78rem; margin-left: auto; }
  .ws-open { border: 1px solid var(--line); border-radius: 8px; padding: .3rem .8rem; font-weight: 700; font-size: .82rem; color: var(--accent); text-decoration: none; }
  .ws-open:hover { border-color: var(--accent); }
  .ws-open.off { color: var(--muted); font-weight: 400; border-color: transparent; padding-right: 0; }
  .empty { color: var(--muted); justify-content: center; text-align: center; }
  code { font-family: ui-monospace, monospace; font-size: .92em; }
  footer { color: var(--muted); font-size: .76rem; margin-top: auto; padding-top: 2rem; line-height: 1.5; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="brand-mark">W</span><span class="brand-name">wikiLLM</span><span class="brand-tag">· workspaces</span></div>
  <h1>Workspaces</h1>
  <p class="lead">Status of the workspaces managed on this host. Open one when it is running. This page needs no sign-in.</p>
  ${warning}
  <ul>${body}</ul>
  <footer>Public status page · ${MANAGER_VERSION ? `manager ${escapeHtml(MANAGER_VERSION)} · ` : ''}refreshed every 15 s. It names workspaces and exposes nothing else; disable it with <code>WIKI_MANAGER_HUB=off</code> or bind it to loopback with <code>WIKI_MANAGER_HUB_HOST=127.0.0.1</code>.</footer>
</div>
</body>
</html>`;
}

export async function startHubServer({
  host = '0.0.0.0',
  port = 8080,
  listWorkspaces = listWorkspacesFromRegistry,
  readStates = readServeStates,
  isPortReachable = probePort,
  log = (message) => console.log(message),
} = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ok: true, page: 'workspaces' }));
        return;
      }
      if (url.pathname !== '/' || request.method !== 'GET') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('Not found');
        return;
      }
      const workspaces = listWorkspaces().sort((a, b) => a.name.localeCompare(b.name));
      const state = await readStates();
      let probed = null;
      if (!state.ok) {
        probed = new Map(await Promise.all(workspaces.map(async (workspace) => {
          const servePort = Number(workspace.env?.WIKI_SERVE_PORT) || null;
          return [workspace.name, servePort ? await isPortReachable(servePort) : false];
        })));
      }
      const html = hubPageHtml({
        rows: workspaceRows({ workspaces, states: state.states, probed, requestHost: hostnameForLinks(request) }),
        dockerError: state.ok ? null : state.error,
        workspaceCount: workspaces.length,
      });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`Workspace page unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      log(`[hub] workspaces page on http://${host}:${boundPort}/`);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const address = server.address();
  return {
    host,
    port: typeof address === 'object' && address ? address.port : port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
