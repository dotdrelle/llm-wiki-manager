import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { totpCode } from './totp.js';
import {
  enrollment,
  isTotpEnabled,
  issueSessionWithTotp,
  loginAttemptAllowed,
  loginStatus,
  resetTotpEnrollment,
  revokeSession,
  SESSION_TTL_MS,
  verifySessionToken,
} from './loginSession.js';

// Each test gets a fresh in-memory enrollment and a fresh state dir.
function freshStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'login-session-'));
  process.env.WIKI_MANAGER_STATE_DIR = dir;
  return dir;
}

test.afterEach(() => {
  const dir = process.env.WIKI_MANAGER_STATE_DIR;
  if (dir && dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
  delete process.env.WIKI_MANAGER_STATE_DIR;
});

test('enrollment publishes a secret and URI, then the first code persists it', () => {
  freshStateDir();
  const before = enrollment();
  assert.ok(before.secret.match(/^[A-Z2-7]{32}$/));
  assert.ok(before.uri.startsWith('otpauth://totp/'));
  assert.equal(loginStatus().enrolled, false);

  // The SAME pending secret is shown again (the page reloads, not re-rolls).
  assert.equal(enrollment().secret, before.secret);

  const result = issueSessionWithTotp(totpCode(before.secret));
  assert.equal(result.ok, true);
  assert.equal(result.enrolled, true);
  assert.ok(result.token.length >= 32);
  assert.equal(loginStatus().enrolled, true);
  assert.equal(enrollment(), null);
});

test('a wrong code never enrolls and never issues a session', () => {
  freshStateDir();
  const pending = enrollment();
  const wrong = totpCode(pending.secret) === '000000' ? '111111' : '000000';
  const result = issueSessionWithTotp(wrong);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_code');
  assert.equal(loginStatus().enrolled, false);
});

test('enrollment is refused from a non-loopback address', () => {
  freshStateDir();
  const pending = enrollment();
  const result = issueSessionWithTotp(totpCode(pending.secret), { remoteAddress: '192.168.1.10' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'enrollment_requires_loopback');
  // From loopback the same code succeeds.
  const ok = issueSessionWithTotp(totpCode(pending.secret), { remoteAddress: '127.0.0.1' });
  assert.equal(ok.ok, true);
});

test('a verified session slides instead of expiring', () => {
  freshStateDir();
  const pending = enrollment();
  const issued = issueSessionWithTotp(totpCode(pending.secret));
  assert.ok(issued.token);

  // Right after issue: valid.
  assert.equal(verifySessionToken(issued.token).ok, true);
  // Near the end of the TTL: still valid, and the slide pushes expiry forward.
  const late = issued.expiresAt - 1;
  const check = verifySessionToken(issued.token, { timestamp: late });
  assert.equal(check.ok, true);
  assert.ok(check.expiresAt > issued.expiresAt);
  // Past the NEW expiry the token is refused.
  const past = check.expiresAt + 1;
  assert.equal(verifySessionToken(issued.token, { timestamp: past, renew: false }).ok, false);
});

test('an unknown token is refused and revocation invalidates the real one', () => {
  freshStateDir();
  const pending = enrollment();
  const issued = issueSessionWithTotp(totpCode(pending.secret));

  assert.equal(verifySessionToken('nope').ok, false);
  assert.equal(revokeSession(issued.token), true);
  assert.equal(verifySessionToken(issued.token).ok, false);
  assert.equal(loginStatus().sessionActive, false);
  // Revoking twice is a no-op, not an error.
  assert.equal(revokeSession(issued.token), false);
});

test('resetTotpEnrollment wipes the secret and the session for re-enrollment', () => {
  freshStateDir();
  const pending = enrollment();
  const issued = issueSessionWithTotp(totpCode(pending.secret));
  assert.equal(loginStatus().enrolled, true);
  assert.equal(loginStatus().sessionActive, true);

  resetTotpEnrollment();

  const status = loginStatus();
  assert.equal(status.enrolled, false);
  assert.equal(status.sessionActive, false);
  assert.equal(verifySessionToken(issued.token).ok, false);
  // A fresh enrollment secret is generated for the next page.
  const fresh = enrollment();
  assert.ok(fresh.secret);
  assert.notEqual(fresh.secret, pending.secret);
});

test('login attempts are rate-limited per address', () => {
  for (let index = 0; index < 10; index++) {
    const allowed = loginAttemptAllowed('127.0.0.1');
    assert.equal(allowed.ok, true, `attempt ${index}`);
  }
  const refused = loginAttemptAllowed('127.0.0.1');
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterSeconds > 0);
  // Another address is unaffected.
  assert.equal(loginAttemptAllowed('10.0.0.2').ok, true);
});

test('TOTP can be disabled from the environment', () => {
  freshStateDir();
  process.env.WIKI_MANAGER_TOTP = 'off';
  assert.equal(isTotpEnabled(), false);
  assert.equal(enrollment(), null);
  delete process.env.WIKI_MANAGER_TOTP;
});

test('the default session TTL is 12 hours', () => {
  assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
});
