#!/usr/bin/env node
// hub.js — workspace manager API, host-side background process
// Started automatically by wiki-workspace when a serve session opens.
// Usage: node hub.js <root_dir> <workspaces_dir> <token>
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const net    = require('net');
const { spawn } = require('child_process');

const [,, ROOT_DIR, WORKSPACES_DIR, HUB_TOKEN] = process.argv;

if (!ROOT_DIR || !WORKSPACES_DIR || !HUB_TOKEN) {
  process.stderr.write('Usage: node hub.js <root_dir> <workspaces_dir> <token>\n');
  process.exit(1);
}

const HUB_DIR      = path.join(ROOT_DIR, '.hub');
const STATE_FILE   = path.join(HUB_DIR, 'state.json');
const COMPOSE_FILE = path.join(ROOT_DIR, 'docker-compose.yml');
const MANAGER_ENV  = path.join(ROOT_DIR, '.env');

let hubPort = 0;

// ── workspace discovery ───────────────────────────────────────────────────────

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim().replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function listWorkspaces() {
  if (!fs.existsSync(WORKSPACES_DIR)) return [];
  return fs.readdirSync(WORKSPACES_DIR).flatMap(entry => {
    const envFile = path.join(WORKSPACES_DIR, entry, '.env');
    if (!fs.existsSync(envFile)) return [];
    const e = readEnvFile(envFile);
    return [{
      name:           e.WORKSPACE_NAME || entry,
      servePort:      parseInt(e.WIKI_SERVE_PORT      || '3100', 10),
      mcpPort:        parseInt(e.WIKI_MCP_PORT         || '3101', 10),
      cmePort:        parseInt(e.CME_MCP_PORT          || '3102', 10),
      productionPort: parseInt(e.PRODUCTION_MCP_PORT   || '3103', 10),
      workspacePath:  e.WIKI_WORKSPACE_PATH || '',
      envFile,
    }];
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isListening(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.setTimeout(400);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error',   () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

function projectName(name) {
  return `wiki-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function appleScriptString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function openBrowser(url, workspaceName) {
  if (process.platform === 'darwin') {
    const targetUrl = appleScriptString(url);
    const targetTitle = appleScriptString(workspaceName || '');
    const focusScript = `
on focusSystemWindow(targetTitle)
  if targetTitle is "" then return false
  tell application "System Events"
    repeat with appName in {"Google Chrome", "Microsoft Edge"}
      repeat with p in (application processes whose name is appName)
        repeat with w in windows of p
          try
            if (name of w as text) contains targetTitle then
              perform action "AXRaise" of w
              set frontmost of p to true
              return true
            end if
          end try
        end repeat
      end repeat
    end repeat
  end tell
  return false
end focusSystemWindow

on focusChromeApp(appName, targetUrl)
  tell application appName
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t) starts with targetUrl then
          set active tab index of w to (index of t)
          set index of w to 1
          activate
          return true
        end if
      end repeat
    end repeat
  end tell
  return false
end focusChromeApp

if focusSystemWindow("${targetTitle}") then
  return
end if
if focusChromeApp("Google Chrome", "${targetUrl}") then
  return
end if
try
  if focusChromeApp("Microsoft Edge", "${targetUrl}") then
    return
  end if
end try
error "window not found"
`;
    const focus = spawn('osascript', ['-e', focusScript], { stdio: 'ignore' });
    focus.on('close', code => {
      if (code === 0) return;
      openBrowserAppMode(url);
    });
    focus.on('error', () => openBrowserAppMode(url));
    focus.unref();
    return;
  }
  openBrowserAppMode(url);
}

function openBrowserAppMode(url) {
  if (process.platform === 'darwin') {
    const fallback = () => spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    const openEdge = () => {
      const edge = spawn('open', ['-na', 'Microsoft Edge', '--args', `--app=${url}`], { stdio: 'ignore', detached: true });
      edge.on('error', fallback);
      edge.on('close', code => { if (code !== 0) fallback(); });
      edge.unref();
    };
    const chrome = spawn('open', ['-na', 'Google Chrome', '--args', `--app=${url}`], { stdio: 'ignore', detached: true });
    chrome.on('error', openEdge);
    chrome.on('close', code => { if (code !== 0) openEdge(); });
    chrome.unref();
  } else if (process.platform === 'linux') {
    const candidates = [
      'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
      'microsoft-edge', 'microsoft-edge-stable',
    ];
    (function tryNext(list) {
      const [cmd, ...rest] = list;
      if (!cmd) { spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref(); return; }
      const proc = spawn(cmd, [`--app=${url}`], { stdio: 'ignore', detached: true });
      proc.on('error', () => tryNext(rest));
      proc.unref();
    }(candidates));
  } else if (process.platform === 'win32') {
    const exes = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    (function tryNext(list) {
      const [exe, ...rest] = list;
      if (!exe) { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, shell: true }).unref(); return; }
      const proc = spawn(exe, [`--app=${url}`], { stdio: 'ignore', detached: true });
      proc.on('error', () => tryNext(rest));
      proc.unref();
    }(exes));
  }
}

// ── docker compose ────────────────────────────────────────────────────────────

function dockerCompose(ws, args) {
  const e   = readEnvFile(ws.envFile);
  const cmd = ['compose'];
  if (fs.existsSync(MANAGER_ENV)) cmd.push('--env-file', MANAGER_ENV);
  cmd.push('--env-file', ws.envFile, '-f', COMPOSE_FILE, '-p', projectName(ws.name), ...args);
  const env = {
    ...process.env,
    WIKI_WORKSPACE_PATH:  e.WIKI_WORKSPACE_PATH || '',
    WIKI_SERVE_PORT:      e.WIKI_SERVE_PORT      || '3100',
    WIKI_MCP_PORT:        e.WIKI_MCP_PORT        || '3101',
    CME_MCP_PORT:         e.CME_MCP_PORT         || '3102',
    HUB_PORT:             String(hubPort),
    HUB_TOKEN:            HUB_TOKEN,
    HUB_INTERNAL_HOST:    'host.docker.internal',
    WORKSPACE_NAME:       ws.name,
  };
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('docker', cmd, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-300))));
  });
}

// ── session refcount ──────────────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { sessions: [] }; }
}

function saveState(s) {
  fs.mkdirSync(HUB_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function addSession(workspace, pid) {
  const s = readState();
  s.sessions = (s.sessions || []).filter(x => x.pid !== pid);
  s.sessions.push({ workspace, pid });
  saveState(s);
}

function removeSession(pid) {
  const s = readState();
  s.sessions = (s.sessions || []).filter(x => x.pid !== pid && pidAlive(x.pid));
  saveState(s);
  return s.sessions.length;
}

function openWorkspaceTimestamps() {
  const s = readState();
  return s.openWorkspaceTimestamps && typeof s.openWorkspaceTimestamps === 'object'
    ? s.openWorkspaceTimestamps
    : {};
}

function markWorkspaceOpened(name) {
  const s = readState();
  s.openWorkspaceTimestamps =
    s.openWorkspaceTimestamps && typeof s.openWorkspaceTimestamps === 'object'
      ? s.openWorkspaceTimestamps
      : {};
  s.openWorkspaceTimestamps[name] = Date.now();
  saveState(s);
}

async function stopAllServeContainers() {
  const all = listWorkspaces();
  await Promise.allSettled(all.map(ws => dockerCompose(ws, ['stop', 'serve'])));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function sendJson(res, status, data) {
  const b = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(b);
}

function readBody(req) {
  return new Promise(resolve => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c).toString()));
  });
}

const server = http.createServer(async (req, res) => {
  if ((req.headers['authorization'] || '') !== `Bearer ${HUB_TOKEN}`) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  const urlPath = req.url.split('?')[0].replace(/^\/+|\/+$/g, '');
  const parts   = urlPath.split('/');

  try {
    // GET /workspaces → list + running status
    if (req.method === 'GET' && urlPath === 'workspaces') {
      const all  = listWorkspaces();
      const runs = await Promise.all(all.map(w => isListening(w.servePort)));
      const opened = openWorkspaceTimestamps();
      const now = Date.now();
      return sendJson(res, 200, {
        ok: true,
        workspaces: all.map((w, i) => ({
          name: w.name,
          servePort: w.servePort,
          running: runs[i],
          opened: Boolean(opened[w.name] && now - opened[w.name] < 15000),
        })),
      });
    }

    // POST /workspaces/:name/(start|stop|open)
    if (req.method === 'POST' && parts[0] === 'workspaces' && parts[1] && parts[2]) {
      const wsName = decodeURIComponent(parts[1]);
      const ws = listWorkspaces().find(w => w.name === wsName);
      if (!ws) return sendJson(res, 404, { ok: false, error: 'workspace not found' });

      if (parts[2] === 'start') {
        // Fire-and-forget; browser polls /workspaces for ready status
        (async () => {
          await dockerCompose(ws, ['up', '-d', 'mcp-http', 'production-mcp']);
          await dockerCompose(ws, ['up', '-d', '--force-recreate', 'serve']);
        })().catch(e => process.stderr.write(`hub start ${ws.name}: ${e.message}\n`));
        return sendJson(res, 200, { ok: true, starting: true });
      }

      if (parts[2] === 'stop') {
        dockerCompose(ws, ['stop', 'serve', 'mcp-http', 'production-mcp'])
          .catch(e => process.stderr.write(`hub stop ${ws.name}: ${e.message}\n`));
        return sendJson(res, 200, { ok: true, stopping: true });
      }

      if (parts[2] === 'open') {
        markWorkspaceOpened(ws.name);
        openBrowser(`http://localhost:${ws.servePort}`, ws.name);
        return sendJson(res, 200, { ok: true, opened: true });
      }

      if (parts[2] === 'heartbeat') {
        markWorkspaceOpened(ws.name);
        return sendJson(res, 200, { ok: true });
      }
    }

    // POST /sessions/register   { workspace, pid }
    // POST /sessions/deregister { pid }
    if (req.method === 'POST' && parts[0] === 'sessions') {
      const data = JSON.parse(await readBody(req));
      if (parts[1] === 'register') {
        addSession(data.workspace, data.pid);
        return sendJson(res, 200, { ok: true });
      }
      if (parts[1] === 'deregister') {
        const remaining = removeSession(data.pid);
        if (remaining === 0) {
          await stopAllServeContainers();
        }
        return sendJson(res, 200, { ok: true, remaining });
      }
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

// ── boot ──────────────────────────────────────────────────────────────────────

function freePort(start) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(start, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', () => freePort(start + 1).then(resolve, reject));
  });
}

async function main() {
  const port = await freePort(49200);
  hubPort = port;
  fs.mkdirSync(HUB_DIR, { recursive: true });
  // Write state only once the server is actually listening (avoids race with wiki-workspace poll)
  server.listen(port, '127.0.0.1', () => {
    saveState({ pid: process.pid, port, token: HUB_TOKEN, sessions: [] });
  });

  const exit = () => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', exit);
  process.on('SIGINT',  exit);
}

main().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
