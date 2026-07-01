import { execFile, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuntimeHealth, runtimeUrlFromEnv } from './client.js';
import { defaultRuntimeStateDir } from '../core/env.js';
import { resolveRuntimeAuthToken, runtimeTokenFromEnv } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const managerRoot = resolve(__dirname, '../..');
const binPath = resolve(managerRoot, 'bin/wiki-manager.js');

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
  host = process.env.WIKI_MANAGER_RUNTIME_HOST ?? '0.0.0.0',
  port = Number(process.env.WIKI_MANAGER_RUNTIME_PORT ?? 7788),
  stateDir = process.env.WIKI_MANAGER_STATE_DIR ?? defaultRuntimeStateDir(),
  url = process.env.WIKI_MANAGER_RUNTIME_URL ?? `http://127.0.0.1:${port}`,
  timeoutMs = 5000,
} = {}) {
  const auth = resolveRuntimeAuthToken({ host, stateDir });
  if (auth.token) process.env.WIKI_MANAGER_RUNTIME_TOKEN = auth.token;
  const existing = await runtimeHealthOrNull(url, auth.token);
  if (existing) return { url, started: false, health: existing, token: auth.token, tokenPath: auth.tokenPath };

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

export async function runtimeHealthOrNull(url = runtimeUrlFromEnv(), token = runtimeTokenFromEnv()) {
  try {
    return await checkRuntimeHealth({ url, token });
  } catch {
    return null;
  }
}
