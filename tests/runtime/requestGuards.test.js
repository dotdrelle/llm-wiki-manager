import assert from 'node:assert/strict';
import test from 'node:test';
import { startRuntimeServer } from '../../src/runtime/server.js';
import { createHostGuard, isJsonRequest, publicRouteNeedsJson } from '../../src/runtime/requestGuards.js';

test('host guard: IP literals and known names pass, a rebinding name is refused once-logged', () => {
  const warnings = [];
  const allowed = createHostGuard({ bindHost: '0.0.0.0', allowedHosts: 'wiki.example.org', warn: (line) => warnings.push(line) });
  for (const host of ['127.0.0.1:7788', '192.168.1.10:7788', '[::1]:7788', 'localhost:7788', 'host.docker.internal:7788', 'wiki.example.org', 'app.localhost']) {
    assert.equal(allowed(host), true, host);
  }
  assert.equal(allowed('attacker.example:7788'), false);
  assert.equal(allowed('attacker.example'), false);
  assert.equal(warnings.length, 1, 'one log line per refused name, not per request');
  assert.equal(allowed(''), false);
  assert.equal(allowed(undefined), true);
});

test('host guard: a named bind host is accepted', () => {
  assert.equal(createHostGuard({ bindHost: 'manager.lan', allowedHosts: '' })('manager.lan:7788'), true);
});

test('JSON rule covers only the public POST routes', () => {
  assert.equal(publicRouteNeedsJson('POST', '/login/verify'), true);
  assert.equal(publicRouteNeedsJson('POST', '/maintenance/bridge'), true);
  assert.equal(publicRouteNeedsJson('POST', '/cancel'), false);
  assert.equal(publicRouteNeedsJson('GET', '/login'), false);
  assert.equal(isJsonRequest({ 'content-type': 'application/json; charset=utf-8' }), true);
  assert.equal(isJsonRequest({ 'content-type': 'text/plain' }), false);
  assert.equal(isJsonRequest({}), false);
});

test('the runtime answers 421 to a foreign Host and 415 to a text/plain login', async () => {
  const handle = await startRuntimeServer({ host: '127.0.0.1', port: 0, token: 'secret-token', session: { workspace: 'demo' } });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const { request } = await import('node:http');
    const status = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const req = request(`${base}${path}`, { method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(await status('/login/status', { headers: { host: 'attacker.example' } }), 421);
    assert.equal(await status('/login/status'), 200);
    assert.equal(await status('/login/verify', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"code":"000000"}' }), 415);
    assert.equal(await status('/state'), 401, 'bearer still required on gated routes');
  } finally {
    await handle.close();
  }
});
