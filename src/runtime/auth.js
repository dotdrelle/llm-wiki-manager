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

/*
 * A token is resolved whatever the bind host. Only the wildcard binds used to
 * get one: a runtime on 127.0.0.1 — or on one LAN address — answered every
 * route unauthenticated, so any web page the operator visited could POST a
 * turn or an approval to it (no CORS preflight for a text/plain body), and a
 * LAN bind was open to the whole network. `host` is kept in the signature for
 * the callers; it no longer changes the answer.
 */
export function resolveRuntimeAuthToken({
  stateDir = defaultRuntimeStateDir(),
  explicitToken = runtimeTokenFromEnv(),
} = {}) {
  if (explicitToken) return { token: explicitToken, source: 'env', tokenPath: null };

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
