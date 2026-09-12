import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntimeServer } from './server.js';
import { enrollment, issueSessionWithTotp } from './loginSession.js';
import { totpCode } from './totp.js';

/*
 HTTP-level contract of the TOTP login surface: public before the bearer
 gate, enrollment on the first code, session verification behind the bearer,
 revocation. The store is stubbed — none of these routes touch it.
 */

let stateDir;
let server;

test.before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'login-routes-'));
  process.env.WIKI_MANAGER_STATE_DIR = stateDir;
  server = await startRuntimeServer({ host: '127.0.0.1', port: 0, store: { dbPath: null } });
});

test.after(async () => {
  await server.close();
  delete process.env.WIKI_MANAGER_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

function baseUrl() {
  return `http://127.0.0.1:${server.port}`;
}

test('GET /login shows the enrollment QR before any code was verified', async () => {
  const response = await fetch(`${baseUrl()}/login`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Enroll your authenticator/);
  assert.match(html, /<svg/); // the QR code
  assert.match(html, /GE|base32/i);
  const status = await (await fetch(`${baseUrl()}/login/status`)).json();
  assert.deepEqual({ enabled: status.enabled, enrolled: status.enrolled }, { enabled: true, enrolled: false });
});

test('the first verified code enrolls and issues a session', async () => {
  const pending = enrollment();
  const code = totpCode(pending.secret);
  const response = await fetch(`${baseUrl()}/login/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.token.length >= 32);
  assert.ok(payload.expiresAt > Date.now());
  assert.match(payload.page, /Session active/);
  // The session must reach the browser as a cookie, on the runtime's origin:
  // that is what lets serve on the same host reuse the ShellUI login instead
  // of asking for a second TOTP code.
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /wiki_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.ok(setCookie.includes(payload.token));

  const status = await (await fetch(`${baseUrl()}/login/status`)).json();
  assert.equal(status.enrolled, true);
  assert.equal(status.sessionActive, true);
});

test('a wrong code is refused and repeated tries are rate-limited', async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(`${baseUrl()}/login/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    assert.equal(response.status, 401, `attempt ${attempt}`);
    assert.equal((await response.json()).error, 'Invalid verification code.');
  }
  const refused = await fetch(`${baseUrl()}/login/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '000000' }),
  });
  assert.equal(refused.status, 429);
});

test('GET /session/verify checks the issued token and slides it', async () => {
  const enrolledSecret = JSON.parse(readFileSync(join(stateDir, 'totp.json'), 'utf8')).secret;
  const issued = issueSessionWithTotp(totpCode(enrolledSecret));
  assert.equal(issued.ok, true);
  const response = await fetch(`${baseUrl()}/session/verify?token=${encodeURIComponent(issued.token)}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.ident, 'human');
  assert.ok(payload.expiresAt > Date.now());

  const unknown = await fetch(`${baseUrl()}/session/verify?token=nope`);
  assert.equal((await unknown.json()).ok, false);
});

test('POST /logout without the session token does not revoke it', async () => {
  const enrolledSecret = JSON.parse(readFileSync(join(stateDir, 'totp.json'), 'utf8')).secret;
  const issued = issueSessionWithTotp(totpCode(enrolledSecret));
  assert.equal(issued.ok, true);
  const response = await fetch(`${baseUrl()}/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, false);
  const after = await (await fetch(`${baseUrl()}/login/status`)).json();
  assert.equal(after.sessionActive, true, 'this route sits before the bearer gate — a caller with no proof of the token must not be able to force the session out');
});

test('POST /logout with the session token revokes it', async () => {
  const enrolledSecret = JSON.parse(readFileSync(join(stateDir, 'totp.json'), 'utf8')).secret;
  const issued = issueSessionWithTotp(totpCode(enrolledSecret));
  assert.equal(issued.ok, true);
  const response = await fetch(`${baseUrl()}/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: issued.token }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, true);
  const after = await (await fetch(`${baseUrl()}/login/status`)).json();
  assert.equal(after.sessionActive, false);
});
