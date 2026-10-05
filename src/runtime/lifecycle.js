import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeCacertPath } from '../core/cacert.js';
import { checkRuntimeHealth, postRuntimeShutdown, runtimeUrlFromEnv } from './client.js';
import { defaultRuntimeStateDir } from '../core/env.js';
import { resolveRuntimeAuthToken, runtimeTokenFromEnv } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const managerRoot = resolve(__dirname, '../..');
const binPath = resolve(managerRoot, 'bin/wiki-manager.js');

// Newest mtime (ms) of the manager's own source tree. Used to detect that the
// code was edited after a reused runtime started, so ensureRuntime can restart
// it instead of serving stale code. Returns 0 if the source tree is unreadable
// (e.g. running from a packed install) — in that case staleness is not checked.
function newestManagerSourceMtimeMs() {
  const srcDir = join(managerRoot, 'src');
  let newest = 0;
  try {
    for (const entry of readdirSync(srcDir, { recursive: true })) {
      const name = String(entry);
      if (!(name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.tsx'))) continue;
      try {
        const mtime = statSync(join(srcDir, name)).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch { /* file vanished mid-scan */ }
    }
  } catch { return 0; }
  return newest;
}

export function runtimeNodeExecutable() {
  return process.versions.bun
    ? (process.env.WIKI_MANAGER_NODE_BIN ?? 'node')
    : process.execPath;
}

export async function assertRuntimeNode(executable = runtimeNodeExecutable()) {
  const version = await new Promise((resolveVersion, reject) => {
    execFile(executable, ['-p', 'process.versions.node'], (err, stdout) => {
      if (err) {
        reject(new Error(`Runtime requires Node.js 22+; could not execute ${executable}. Set WIKI_MANAGER_NODE_BIN to a Node.js 22 binary.`));
        return;
      }
      resolveVersion(String(stdout).trim());
    });
  });
  const major = Number(String(version).split('.')[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Runtime requires Node.js 22+ for node:sqlite; ${executable} is Node ${version}. Set WIKI_MANAGER_NODE_BIN to a Node.js 22 binary.`);
  }
  return { executable, version };
}

export async function ensureRuntime({
  // 0.0.0.0, like `wiki-workspace runtime up` has always used: the shell's
  // autostarted runtime used to bind 127.0.0.1, so `serve` in Docker got
  // ECONNREFUSED on host.docker.internal and the workspace UI reported no
  // runtime. Exposing the port always generates an auth token.
  host = process.env.WIKI_MANAGER_RUNTIME_HOST ?? '0.0.0.0',
  port = Number(process.env.WIKI_MANAGER_RUNTIME_PORT ?? 7788),
  stateDir = process.env.WIKI_MANAGER_STATE_DIR ?? defaultRuntimeStateDir(),
  url = process.env.WIKI_MANAGER_RUNTIME_URL ?? `http://127.0.0.1:${port}`,
  timeoutMs = 5000,
  forceRestart = false,
} = {}) {
  const auth = resolveRuntimeAuthToken({ host, stateDir });
  if (auth.token) process.env.WIKI_MANAGER_RUNTIME_TOKEN = auth.token;
  const existing = await runtimeHealthOrNull(url, auth.token);
  if (existing) {
    const expectedCacertPath = activeCacertPath();
    const actualCacertPath = existing.cacertPath ? resolve(existing.cacertPath) : null;
    // Dev staleness: if the manager source was edited after this runtime
    // started, the reused process would keep serving old code (the recurring
    // "my change is not taking effect" trap). Treat it as stale and restart.
    // Packed installs report mtime 0 (unreadable src) → never flagged stale.
    // Opt out with WIKI_MANAGER_RUNTIME_NO_STALE_CHECK=1.
    const startedAtMs = Number(existing.startedAtMs) || 0;
    const sourceMtimeMs = process.env.WIKI_MANAGER_RUNTIME_NO_STALE_CHECK === '1' ? 0 : newestManagerSourceMtimeMs();
    const stale = startedAtMs > 0 && sourceMtimeMs > startedAtMs;
    // forceRestart: the caller knows the manager configuration just changed
    // (e.g. mcp.endpoints.json scaffolded on first run) — a runtime started
    // BEFORE that only knows the old endpoints and would keep answering
    // without the agents until manually restarted.
    if (!forceRestart && !stale && actualCacertPath === expectedCacertPath) {
      return { url, started: false, health: existing, token: auth.token, tokenPath: auth.tokenPath };
    }
    if (stale) console.log('\x1b[32mruntime: source changed since start — restarting for fresh code.\x1b[0m');
    await postRuntimeShutdown({ url, token: auth.token });
    await waitForRuntimeShutdown(url, auth.token, 2500);
  }

  const runtimeNode = await assertRuntimeNode();
  // The child wrote to `stdio: 'ignore'`. A runtime that crashed at startup —
  // port taken, unreadable SQLite state, invalid config — therefore left no
  // trace, and the shell had only a "did not become healthy" to display. We
  // redirect to the same `runtime.log` as `wiki-workspace runtime up`, so
  // both start paths diagnose themselves the same way.
  const logPath = runtimeLogPath(stateDir);
  let logFd = null;
  try {
    mkdirSync(resolve(stateDir), { recursive: true });
    logFd = openSync(logPath, 'a');
  } catch { /* the log is a comfort: never prevent startup */ }

  const child = spawn(runtimeNode.executable, [
    binPath,
    'runtime',
    '--host',
    host,
    '--port',
    String(port),
    '--state-dir',
    stateDir,
  ], {
    detached: true,
    stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ...(auth.token ? { WIKI_MANAGER_RUNTIME_TOKEN: auth.token } : {}),
      WIKI_MANAGER_RUNTIME_CHILD: '1',
    },
  });
  child.unref();
  if (logFd !== null) closeSync(logFd);

  // The pid was missing: `wiki-workspace runtime down` answered "not running"
  // on a runtime started by the shell, and the process stayed on the port.
  writeRuntimePidFile(stateDir, child.pid);

  // A child that dies immediately still made the full delay be waited out.
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + timeoutMs;
  let health = null;
  while (Date.now() < deadline) {
    health = await runtimeHealthOrNull(url, auth.token);
    if (health) return { url, started: true, health, pid: child.pid, token: auth.token, tokenPath: auth.tokenPath, node: runtimeNode };
    if (exited) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  if (exited) removeRuntimePidFile(stateDir);
  throw new Error(await describeRuntimeFailure({ url, token: auth.token, stateDir, exited, logPath }));
}

export function runtimeLogPath(stateDir = defaultRuntimeStateDir()) {
  return join(resolve(stateDir), 'runtime.log');
}

export function runtimePidPath(stateDir = defaultRuntimeStateDir()) {
  return join(resolve(stateDir), 'runtime.pid');
}

function writeRuntimePidFile(stateDir, pid) {
  if (!pid) return;
  try {
    mkdirSync(resolve(stateDir), { recursive: true });
    writeFileSync(runtimePidPath(stateDir), `${pid}\n`, 'utf8');
  } catch { /* idem : informatif, jamais bloquant */ }
}

function removeRuntimePidFile(stateDir) {
  try { unlinkSync(runtimePidPath(stateDir)); } catch { /* already absent */ }
}

/**
 * Runtime startup failure message.
 *
 * `checkRuntimeHealth` returns `null` on any non-2xx response: a 401 — token
 * read from another `state-dir` than the already-running runtime's — was
 * therefore strictly indistinguishable from a closed port. Here we re-issue
 * the request to tell the two apart, and attach the end of the log.
 */
async function describeRuntimeFailure({ url, token, stateDir, exited, logPath }) {
  const lines = [`Runtime did not become healthy at ${url}`];

  if (exited) {
    lines.push(
      `The runtime process exited immediately (${exited.signal ? `signal ${exited.signal}` : `code ${exited.code}`}).`,
    );
  }

  const probe = await probeRuntimeHealth(url, token);
  if (probe.status === 401 || probe.status === 403) {
    lines.push(
      `A runtime IS answering on this port but rejected our token (HTTP ${probe.status}).`,
      `It was started from another state directory: this one is ${resolve(stateDir)}.`,
      'Stop it (`wiki-workspace runtime down` from that directory, or kill the process holding the port) or export WIKI_MANAGER_RUNTIME_TOKEN with its token.',
    );
  } else if (probe.status) {
    lines.push(`Health endpoint answered HTTP ${probe.status}.`);
  } else if (probe.error) {
    lines.push(`Health endpoint unreachable: ${probe.error}`);
  }

  const tail = readLogTail(logPath, 12);
  if (tail) lines.push(`Last lines of ${logPath}:`, tail);
  else lines.push(`No runtime log at ${logPath}.`);

  return lines.join('\n');
}

async function probeRuntimeHealth(url, token) {
  try {
    const response = await fetch(`${String(url).replace(/\/+$/, '')}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    return { status: response.status, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function readLogTail(logPath, count) {
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-count).map((line) => `  ${line}`).join('\n') || null;
  } catch {
    return null;
  }
}

async function waitForRuntimeShutdown(url, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await runtimeHealthOrNull(url, token)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

export async function runtimeHealthOrNull(url = runtimeUrlFromEnv(), token = runtimeTokenFromEnv(), signal = null) {
  try {
    return await checkRuntimeHealth({ url, token, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}
