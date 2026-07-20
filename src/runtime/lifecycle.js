import { execFile, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
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
  host = process.env.WIKI_MANAGER_RUNTIME_HOST ?? '127.0.0.1',
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
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(auth.token ? { WIKI_MANAGER_RUNTIME_TOKEN: auth.token } : {}),
      WIKI_MANAGER_RUNTIME_CHILD: '1',
    },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let health = null;
  while (Date.now() < deadline) {
    health = await runtimeHealthOrNull(url, auth.token);
    if (health) return { url, started: true, health, pid: child.pid, token: auth.token, tokenPath: auth.tokenPath, node: runtimeNode };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Runtime did not become healthy at ${url}`);
}

async function waitForRuntimeShutdown(url, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await runtimeHealthOrNull(url, token)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

export async function runtimeHealthOrNull(url = runtimeUrlFromEnv(), token = runtimeTokenFromEnv()) {
  try {
    return await checkRuntimeHealth({ url, token });
  } catch {
    return null;
  }
}

// Contract with the user: the shell OWNS the runtime it started — leaving it
// alive after exit produced zombie runtimes running yesterday's code and
// yesterday's endpoints. Nuance preserved: if a run is active anywhere, the
// runtime is left alive so the run survives the shell (that promise stays).
export async function shutdownOwnedRuntime(runtime, { log = (_message) => {} } = {}) {
  if (!runtime?.url || !runtime?.started) return { action: 'kept', reason: 'not_owned' };
  try {
    const health = await runtimeHealthOrNull(runtime.url, runtime.token);
    if (!health) return { action: 'kept', reason: 'unreachable' };
    const activeRuns = Array.isArray(health.activeRuns) ? health.activeRuns : [];
    if (activeRuns.length > 0) {
      const labels = activeRuns
        .map((run) => [run.workspace, run.runId ? String(run.runId).slice(0, 8) : null].filter(Boolean).join('/'))
        .join(', ');
      log(`runtime laissé actif : run en cours (${labels}) — il survivra à ce shell ; relance wiki-manager pour le retrouver.`);
      return { action: 'kept', reason: 'run_active', activeRuns };
    }
    await postRuntimeShutdown({ url: runtime.url, token: runtime.token });
    log('runtime arrêté (démarré par ce shell, aucun run en cours).');
    return { action: 'shutdown' };
  } catch (err) {
    return { action: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
