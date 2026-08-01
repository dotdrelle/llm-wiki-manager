import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRuntime, runtimeLogPath, runtimePidPath } from './lifecycle.js';

function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'wiki-runtime-state-'));
}

/**
 * Occupe un port avec un serveur qui répond `status`.
 *
 * Deux effets, tous deux voulus : le runtime que `ensureRuntime` va lancer ne
 * pourra pas se lier au port et sortira aussitôt — c'est le scénario réel du
 * « port déjà pris » — et la sonde de santé recevra un statut choisi.
 */
async function occupiedPort(status) {
  const server = createServer((_req, res) => res.writeHead(status).end('nope'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function failingEnsureRuntime(status) {
  const stateDir = tempStateDir();
  const { server, port } = await occupiedPort(status);
  try {
    const error = await ensureRuntime({
      host: '127.0.0.1',
      port,
      stateDir,
      url: `http://127.0.0.1:${port}`,
      timeoutMs: 3000,
    }).then(() => null, (err) => err);
    assert.ok(error, 'ensureRuntime must fail when nothing healthy answers');
    return { error, stateDir };
  } finally {
    server.close();
  }
}

test('a failed start reports the captured log instead of a bare message', async () => {
  const { error, stateDir } = await failingEnsureRuntime(500);
  assert.match(error.message, /Runtime did not become healthy/);
  // Le fils écrivait sur `stdio: 'ignore'` : sa sortie — ici l'échec de bind —
  // était perdue, et l'opérateur n'avait aucune piste.
  assert.match(error.message, /runtime\.log/);
  assert.ok(existsSync(runtimeLogPath(stateDir)), 'the child output must be captured to a log file');
  assert.match(error.message, /exited immediately|Health endpoint answered HTTP 500/);
});

test('a runtime answering 401 is not reported as unreachable', async () => {
  // Cas réel : un runtime démarré depuis un autre state-dir répond, mais
  // rejette notre jeton. `checkRuntimeHealth` rend `null` sur tout non-2xx,
  // donc ce cas était rigoureusement indiscernable d'un port fermé.
  const { error, stateDir } = await failingEnsureRuntime(401);
  assert.match(error.message, /rejected our token \(HTTP 401\)/);
  assert.match(error.message, /another state directory/);
  assert.ok(error.message.includes(stateDir), 'the message must name the state dir in use');
});

test('the pid file path is the one `wiki-workspace runtime down` reads', () => {
  const stateDir = tempStateDir();
  assert.equal(runtimePidPath(stateDir), join(stateDir, 'runtime.pid'));
  assert.equal(runtimeLogPath(stateDir), join(stateDir, 'runtime.log'));
});
