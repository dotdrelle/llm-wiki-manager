import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeProjectName,
  hubPageHtml,
  readServeStates,
  startHubServer,
} from '../../src/runtime/hub.js';
import { startRuntimeServer } from '../../src/runtime/server.js';

/*
 The public workspace page: no sign-in, workspace names and running state
 only, and a link to the workspaces that answer. Container state comes from
 docker; when docker cannot answer the page says so and probes the serve port
 instead, so a running workspace never disappears in silence.
 */

test('composeProjectName follows the wiki-workspace sanitizing rule', () => {
  assert.equal(composeProjectName('juno'), 'wiki-juno');
  assert.equal(composeProjectName('my.ws 2'), 'wiki-my-ws-2');
});

test('the page links running workspaces only and names the stopped ones', () => {
  const html = hubPageHtml({
    rows: [
      {
        name: 'alpha',
        running: true,
        state: 'running',
        detail: 'Up 3 minutes',
        servePort: 3100,
        url: 'http://box:3100/',
      },
      {
        name: 'beta',
        running: false,
        state: 'exited',
        detail: '',
        servePort: 3200,
        url: null,
      },
    ],
  });
  assert.match(html, /alpha/);
  assert.match(html, /href="http:\/\/box:3100\/"/);
  assert.match(html, /beta/);
  assert.doesNotMatch(html, /href="http:\/\/box:3200\/"/);
  assert.match(html, /Not running/);
  // A public page says nothing about paths, runs or tokens.
  assert.doesNotMatch(html, /workspaces\/alpha|\/home\/|Bearer|runId/i);
});

test('the public page answers without a token and does not expose the runtime API', async () => {
  const server = await startHubServer({
    host: '127.0.0.1',
    port: 0,
    listWorkspaces: () => [
      { name: 'alpha', env: { WIKI_SERVE_PORT: '3100' } },
      { name: 'beta', env: { WIKI_SERVE_PORT: '3200' } },
    ],
    readStates: async () => ({
      ok: true,
      states: new Map([['wiki-alpha', { state: 'running', status: 'Up 3 minutes' }]]),
      error: null,
    }),
    isPortReachable: async () => false,
    log: () => {},
  });
  try {
    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /alpha/);
    assert.match(html, new RegExp(`href="http://127\\.0\\.0\\.1:3100/"`));
    assert.match(html, /beta/);
    assert.doesNotMatch(html, new RegExp(`href="http://127\\.0\\.0\\.1:3200/"`));

    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
    assert.deepEqual(health, { ok: true, page: 'workspaces' });

    const missing = await fetch(`http://127.0.0.1:${server.port}/state`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('a docker failure is announced and the page falls back to port probes', async () => {
  const server = await startHubServer({
    host: '127.0.0.1',
    port: 0,
    listWorkspaces: () => [
      { name: 'alpha', env: { WIKI_SERVE_PORT: '3100' } },
      { name: 'beta', env: { WIKI_SERVE_PORT: '3200' } },
    ],
    readStates: async () => ({
      ok: false,
      states: new Map(),
      error: 'docker is not available on the manager host',
    }),
    isPortReachable: async (port) => port === 3100,
    log: () => {},
  });
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.match(html, /Container state unavailable/);
    assert.match(html, /docker is not available/);
    assert.match(html, new RegExp(`href="http://127\\.0\\.0\\.1:3100/"`));
    assert.doesNotMatch(html, new RegExp(`href="http://127\\.0\\.0\\.1:3200/"`));
  } finally {
    await server.close();
  }
});

test('readServeStates degrades instead of throwing when docker is missing', async () => {
  const missing = await readServeStates({
    execFileFn: (_command, _args, _options, callback) => {
      const error = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      callback(error, '', '');
    },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /docker is not available/);
});

test('the runtime starts the public page next to its own endpoint', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'runtime-hub-'));
  const previousStateDir = process.env.WIKI_MANAGER_STATE_DIR;
  process.env.WIKI_MANAGER_STATE_DIR = stateDir;
  const server = await startRuntimeServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    store: { dbPath: null },
    hubPort: 0,
    hubOptions: {
      listWorkspaces: () => [{ name: 'demo', env: { WIKI_SERVE_PORT: '3100' } }],
      readStates: async () => ({
        ok: true,
        states: new Map([['wiki-demo', { state: 'running', status: 'Up' }]]),
        error: null,
      }),
      log: () => {},
    },
  });
  try {
    assert.ok(server.hub, server.hubError ?? 'hub missing');
    const page = await fetch(`http://127.0.0.1:${server.hub.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /demo/);
    // The page is public while the runtime API still refuses an unauthenticated call.
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/state`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await server.close();
    if (previousStateDir === undefined) delete process.env.WIKI_MANAGER_STATE_DIR;
    else process.env.WIKI_MANAGER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
