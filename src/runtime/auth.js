import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultRuntimeStateDir } from '../core/env.js';

export function runtimeTokenPath(stateDir = defaultRuntimeStateDir()) {
  return join(resolve(stateDir), 'runtime.token');
}

export function runtimeTokenFromEnv() {
  return process.env.WIKI_MANAGER_RUNTIME_TOKEN ?? process.env.RUNTIME_AUTH_TOKEN ?? null;
}

export function resolveRuntimeAuthToken({
  host = '127.0.0.1',
  stateDir = defaultRuntimeStateDir(),
  explicitToken = runtimeTokenFromEnv(),
} = {}) {
  if (explicitToken) return { token: explicitToken, source: 'env', tokenPath: null };
  if (!isExposedHost(host)) return { token: null, source: 'none', tokenPath: null };

  const tokenPath = runtimeTokenPath(stateDir);
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (token) return { token, source: 'file', tokenPath };
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(resolve(stateDir), { recursive: true });
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, source: 'generated', tokenPath };
}

export function isExposedHost(host) {
  return ['0.0.0.0', '::', '[::]'].includes(String(host ?? '').trim());
}
