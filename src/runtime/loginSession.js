import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultRuntimeStateDir } from '../core/env.js';
import { digestEqual, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/*
 The TOTP login authority: one secret, one active session, stored in the
 manager runtime state directory (0600). The session slides — every verified
 check pushes the expiry forward — so "valid for the session" means 12 hours
 of inactivity at most. Nothing here logs secrets or tokens.
 */

const SESSION_TTL_HOURS = Number(process.env.WIKI_MANAGER_SESSION_TTL_HOURS ?? 12);
export const SESSION_TTL_MS = (Number.isFinite(SESSION_TTL_HOURS) && SESSION_TTL_HOURS > 0 ? SESSION_TTL_HOURS : 12) * 60 * 60 * 1000;

// A pending enrollment lives only in memory: the secret is shown on the login
// page BEFORE its first successful code, and only that code persists it.
let pendingEnrollment = null;
let pendingEnrollmentSince = 0;
const PENDING_ENROLLMENT_TTL_MS = 30 * 60 * 1000;

export function isTotpEnabled() {
  const value = String(process.env.WIKI_MANAGER_TOTP ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function stateDir() {
  return resolve(process.env.WIKI_MANAGER_STATE_DIR ?? defaultRuntimeStateDir());
}

function totpPath() {
  return join(stateDir(), 'totp.json');
}

function sessionPath() {
  return join(stateDir(), 'session.json');
}

function writePrivate(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms without chmod semantics */ }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function currentTotpSecret() {
  const record = readJsonFile(totpPath());
  return record && typeof record.secret === 'string' && record.secret ? record : null;
}

export function loginStatus() {
  const session = readJsonFile(sessionPath());
  const sessionActive = Boolean(session && Date.now() < session.expiresAt);
  return {
    enabled: isTotpEnabled(),
    enrolled: currentTotpSecret() !== null,
    sessionActive,
    sessionExpiresAt: sessionActive ? session.expiresAt : null,
  };
}

export function enrollment() {
  if (!isTotpEnabled()) return null;
  if (currentTotpSecret()) return null;
  const now = Date.now();
  if (!pendingEnrollment || now - pendingEnrollmentSince > PENDING_ENROLLMENT_TTL_MS) {
    const secret = generateTotpSecret();
    pendingEnrollment = { secret, label: 'wiki', issuer: 'wikiLLM', createdAt: now };
    pendingEnrollmentSince = now;
  }
  return {
    secret: pendingEnrollment.secret,
    uri: otpauthUri(pendingEnrollment.secret, { label: pendingEnrollment.label, issuer: pendingEnrollment.issuer }),
  };
}

export function isLoopbackAddress(address) {
  // "::" is the unspecified/any address (a bind address, never a real peer's
  // remote address) — only "::1" is actually loopback. Treating it as
  // loopback would trust a connection whose address we failed to read as if
  // it proved local origin.
  const value = String(address ?? '').replace(/^::ffff:/, '').trim();
  if (value === '::1') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  return value.startsWith('127.');
}

/*
 Verifies a 6-digit code and issues the session. The FIRST successful code
 while nothing is enrolled ENROLLS: it persists the pending secret — never a
 code that failed verification. Returns { ok, enrolled, token, expiresAt } or
 { ok: false, error }.
 */
// remoteAddress defaults to loopback, not "unknown": the only production
// caller (server.js's /login/verify) always resolves and passes an explicit
// value (including an explicit null when the socket itself reports none),
// so this default is only ever exercised by a direct/programmatic call with
// no HTTP request behind it at all (tests, internal callers) — which really
// is local, unlike an HTTP request whose remote address could not be read.
export function issueSessionWithTotp(code, { timestamp = Date.now(), remoteAddress = '127.0.0.1' } = {}) {
  if (!isTotpEnabled()) return { ok: false, error: 'totp_disabled' };
  const existing = currentTotpSecret();
  const enrolled = Boolean(existing);
  const secret = existing ? existing.secret : pendingEnrollment?.secret;
  if (!secret) return { ok: false, error: 'no_enrollment' };
  // Enrollment shows the secret in the page: only the host itself may claim
  // it. An address we could not determine is not proof of loopback origin —
  // refuse it, the same as any other non-loopback address.
  if (!enrolled && !isLoopbackAddress(remoteAddress)) {
    return { ok: false, error: 'enrollment_requires_loopback' };
  }
  if (!verifyTotp(secret, code, { timestamp })) return { ok: false, error: 'invalid_code' };
  if (!enrolled) {
    writePrivate(totpPath(), {
      secret,
      issuer: pendingEnrollment?.issuer ?? 'wikiLLM',
      label: pendingEnrollment?.label ?? 'wiki',
      enrolledAt: new Date(timestamp).toISOString(),
    });
    pendingEnrollment = null;
  }
  const token = randomBytes(32).toString('hex');
  const issuedAt = timestamp;
  const session = { token, ident: 'human', issuedAt, lastSeen: issuedAt, expiresAt: issuedAt + SESSION_TTL_MS };
  writePrivate(sessionPath(), session);
  return { ok: true, enrolled: true, token, expiresAt: session.expiresAt };
}

let lastSessionWriteMs = 0;

export function verifySessionToken(token, { timestamp = Date.now(), renew = true } = {}) {
  if (!token) return { ok: false, reason: 'missing_token' };
  const session = readJsonFile(sessionPath());
  if (!session || !digestEqual(session.token, token)) return { ok: false, reason: 'invalid_token' };
  if (!(timestamp < session.expiresAt)) return { ok: false, reason: 'expired' };
  if (renew && timestamp - session.lastSeen > 60_000) {
    session.lastSeen = timestamp;
    session.expiresAt = timestamp + SESSION_TTL_MS;
    // Persist at most once a minute; the slide is generous on purpose.
    if (timestamp - lastSessionWriteMs > 60_000) {
      lastSessionWriteMs = timestamp;
      writePrivate(sessionPath(), session);
    }
  }
  return { ok: true, ident: session.ident, issuedAt: session.issuedAt, lastSeen: session.lastSeen, expiresAt: session.expiresAt };
}

// Requires the session's own token as proof of possession. POST /logout sits
// before the bearer gate by design (the door, not a room) — an unauthenticated
// caller who does not already hold the token must not be able to force the
// legitimate session out.
export function revokeSession(token) {
  const session = readJsonFile(sessionPath());
  if (!session) return false;
  if (!token || !digestEqual(session.token, token)) return false;
  rmSync(sessionPath(), { force: true });
  return true;
}

// The local host CLI (`wiki-manager logout`) has direct access to this state
// directory, same as `resetTotpEnrollment` below — it reads the active
// token itself rather than calling /logout without proof of possession.
export function currentSessionToken() {
  const session = readJsonFile(sessionPath());
  return session && typeof session.token === 'string' ? session.token : null;
}

/*
 Re-enrollment after a lost authenticator: wipes the enrolled secret AND the
 active session, so the next login page shows a fresh QR code. Reachable only
 from the host CLI (`wiki-manager login --reset`): the runtime reads these
 files fresh on every request, so the deletion takes effect immediately, and
 no HTTP route can trigger it.
 */
export function resetTotpEnrollment() {
  pendingEnrollment = null;
  pendingEnrollmentSince = 0;
  rmSync(totpPath(), { force: true });
  rmSync(sessionPath(), { force: true });
}

// ── Attempt rate limiting (in-memory) ────────────────────────────────────────
// 6 digits is a small space: refuse after too many tries per address.
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

export function loginAttemptAllowed(address) {
  const now = Date.now();
  const key = String(address ?? 'unknown');
  const record = attempts.get(key);
  if (!record || now >= record.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return { ok: true, remaining: ATTEMPT_LIMIT - 1 };
  }
  if (record.count >= ATTEMPT_LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    return { ok: false, retryAfterSeconds };
  }
  record.count += 1;
  return { ok: true, remaining: ATTEMPT_LIMIT - record.count };
}

export function resetLoginAttempts(address) {
  attempts.delete(String(address ?? 'unknown'));
}

// Housekeeping: drop records whose window has passed (keeps the map bounded).
export function pruneLoginAttempts() {
  const now = Date.now();
  for (const [key, record] of attempts) {
    if (now >= record.resetAt) attempts.delete(key);
  }
}

export function sessionExists() {
  return existsSync(sessionPath());
}
