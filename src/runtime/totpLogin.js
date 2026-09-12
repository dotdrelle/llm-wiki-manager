import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/*
 The interactive entry gate: `wiki-manager login` opens the runtime's TOTP
 login page in the browser and polls until a session exists. The shell startup
 runs the same flow when a session is required and missing.

 Headless/CI never passes through here — it uses the runtime bearer token, not
 the human session.
 */

export function runtimeBaseUrl(runtime) {
  const base = String(runtime?.url ?? process.env.WIKI_MANAGER_RUNTIME_URL ?? 'http://127.0.0.1:7788');
  return base.replace(/\/+$/, '');
}

export function loginPageUrl(runtime) {
  return `${runtimeBaseUrl(runtime)}/login`;
}

// Returns a promise that reflects the real outcome: spawn() itself does not
// throw for a missing opener (e.g. no xdg-open on a headless box) — that
// surfaces asynchronously as an 'error' event — so callers that want to fall
// back on failure need this to actually reject rather than resolve blindly.
export function openBrowser(url) {
  const target = String(url);
  const options = { detached: true, stdio: 'ignore' };
  return new Promise((resolveOpen, rejectOpen) => {
    let child = null;
    if (process.platform === 'darwin') {
      child = spawn('open', [target], options);
    } else if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', target], options);
    } else {
      child = spawn('xdg-open', [target], options);
    }
    child.once('error', rejectOpen);
    child.once('spawn', () => {
      child.unref?.();
      resolveOpen();
    });
  });
}

export async function fetchLoginStatus(runtime) {
  try {
    const response = await fetch(`${runtimeBaseUrl(runtime)}/login/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// /logout requires the session's own token as proof of possession (it sits
// before the bearer gate by design). The CLI runs on the same host as the
// runtime, so it reads the active token itself — see currentSessionToken in
// loginSession.js — rather than calling this without proof.
export async function revokeRuntimeSession(runtime, token = null) {
  try {
    const response = await fetch(`${runtimeBaseUrl(runtime)}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    return payload?.revoked === true;
  } catch {
    return false;
  }
}

/*
 Requires a valid TOTP session on the runtime, opening the login page and
 polling when one is missing. Returns:
   { ok: true }            — session active (or nothing to do: disabled /
                             runtime unreachable, which the caller announces).
   { ok: false, error }    — the user did not log in within the timeout.
 */
export async function requestTotpSession(runtime, { timeoutMs = 5 * 60 * 1000, open = true, quiet = false } = {}) {
  const status = await fetchLoginStatus(runtime);
  // Every caller reaches this only after ensureRuntime() already confirmed
  // the runtime is up via /health, so a /login/status failure right here is
  // a real problem (route error, blip), not "nothing to gate" — fail CLOSED,
  // matching the documented contract for the same scenario in serve, and say
  // so instead of silently letting the shell start with no TOTP check at all.
  if (!status) {
    return { ok: false, error: `Could not reach the runtime's login status (${runtimeBaseUrl(runtime)}/login/status) — refusing to skip the TOTP check.` };
  }
  if (!status.enabled) return { ok: true, reason: 'totp_disabled' };
  if (status.sessionActive) return { ok: true, expiresAt: status.sessionExpiresAt, reason: 'already_active' };

  const url = loginPageUrl(runtime);
  if (!quiet) console.log(`\x1b[33mTOTP login required — ${url}\x1b[0m`);
  if (open) {
    try {
      await openBrowser(url);
    } catch {
      if (!quiet) console.log(`Open ${url} and enter the code from your authenticator.`);
    }
  } else if (!quiet) {
    console.log(`Open ${url} in your browser and enter the code from your authenticator.`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await fetchLoginStatus(runtime);
    if (current?.sessionActive) {
      if (!quiet) {
        const until = new Date(current.sessionExpiresAt).toLocaleString();
        console.log(`\x1b[32mSession active until ${until}\x1b[0m`);
      }
      return { ok: true, expiresAt: current.sessionExpiresAt, reason: 'logged_in' };
    }
    await sleep(1000);
  }
  return { ok: false, error: `No TOTP session after ${Math.round(timeoutMs / 60_000)} min — run "wiki-manager login" to retry.` };
}
