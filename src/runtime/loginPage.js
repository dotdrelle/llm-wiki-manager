import { qrSvg } from './qrCode.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*
 The single TOTP login page, served by the runtime — and the product's front
 door: what wikiLLM does, what opens after signing in, and a public status
 block. English UI chrome, like every other manager surface.

 The page is public (it is the door, not a room), so the status block carries
 only what a visitor may know: the service answers, its version, since when,
 whether an authenticator is enrolled, the session lifetime and whether this
 connection is encrypted. Never a workspace name, a run, an agent or a path.

 Enrollment shows the QR code, the base32 secret and the otpauth:// URI;
 afterwards the card is a plain 6-digit code form. Verifying here also sets the
 shared `wiki_session` cookie on the runtime's origin (server.js), so the same
 browser reuses the session on serve when it runs on this host; serve sets its
 own cookie when a browser reaches it first.
 */

/** The card that replaces the login form once a code was accepted. */
export function loginSuccessFragment(sessionExpiresAt) {
  return `<section class="card success" id="login-card">
        <h2>Session active</h2>
        <p>You are signed in until <strong>${escapeHtml(new Date(sessionExpiresAt).toLocaleString())}</strong>.</p>
        <p class="hint">You can close this page and return to the ShellUI or the served wiki.</p>
      </section>`;
}

function formatSince(startedAt) {
  if (!Number.isFinite(startedAt)) return null;
  return new Date(startedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function statusRows({ about = {}, enrolled = false, enabled = true, tls = false } = {}) {
  const rows = [
    ['Service', '<span class="dot ok"></span>Online'],
    about.version ? ['Version', escapeHtml(about.version)] : null,
    formatSince(about.startedAt) ? ['Up since', escapeHtml(formatSince(about.startedAt))] : null,
    ['Two-step login', !enabled ? 'Disabled' : enrolled ? 'Authenticator enrolled' : '<span class="dot warn"></span>Awaiting enrollment'],
    Number.isFinite(about.sessionTtlHours) ? ['Session', `${escapeHtml(about.sessionTtlHours)} h, extended while in use`] : null,
    ['Connection', tls ? '<span class="dot ok"></span>Encrypted (TLS)' : '<span class="dot warn"></span>Not encrypted — trusted network only'],
  ].filter(Boolean);
  return rows.map(([label, value]) => `<div class="row"><span>${label}</span><span>${value}</span></div>`).join('');
}

export function loginPageHtml({
  enrolled = false,
  enabled = true,
  secret = null,
  uri = null,
  error = null,
  sessionExpiresAt = null,
  about = {},
  tls = false,
} = {}) {
  const enrolling = !enrolled && secret;
  const loginCard = sessionExpiresAt
    ? loginSuccessFragment(sessionExpiresAt)
    : `<section class="card" id="login-card">
        ${enrolling ? `
        <h2>Enroll your authenticator</h2>
        <p>Scan the QR code with your authenticator app, or enter the secret manually:</p>
        <div class="qr">${qrSvg(uri)}</div>
        <code class="secret">${escapeHtml(secret)}</code>
        <p class="hint">Manual entry: add an account, choose <strong>TOTP</strong> / time-based code, and paste the secret above. Then confirm with the first code below.</p>` : `
        <h2>Sign in</h2>
        <p>Enter the 6-digit code from your authenticator app.</p>`}
        ${enabled ? `<form id="login-form" autocomplete="off">
          <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" aria-label="Verification code" autofocus required>
          <button type="submit" id="submit">Verify</button>
        </form>` : ''}
        <p class="error" id="error"${error ? '' : ' hidden'}>${escapeHtml(error ?? '')}</p>
      </section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wikiLLM — sign in</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f5f7; --fg: #1c1f26; --muted: #6b7280; --card: #fff; --line: #d9dce3; --accent: #2563eb; --accent-soft: #e8efff; --ok: #16a34a; --warn: #d97706; }
  @media (prefers-color-scheme: dark) { :root { --bg: #12141a; --fg: #e7e9ee; --muted: #9aa1ad; --card: #1b1e26; --line: #333843; --accent-soft: #1e2a47; } }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 2rem 1rem 1.5rem; min-height: 100vh; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: .55rem; margin-bottom: 2rem; }
  .brand-mark { width: 2rem; height: 2rem; border-radius: 8px; background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; }
  .brand-name { font-weight: 700; font-size: 1.05rem; }
  .brand-tag { color: var(--muted); font-size: .85rem; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, .85fr); gap: 2.2rem; align-items: start; align-content: start; flex: 1; }
  @media (max-width: 820px) { .grid { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; } .side { order: -1; } .brand-tag { display: none; } h1 { font-size: 1.35rem; } }
  h1 { font-size: 1.65rem; line-height: 1.25; margin: 0 0 .7rem; letter-spacing: -.01em; }
  .lead { color: var(--muted); font-size: .98rem; line-height: 1.55; margin: 0 0 1.6rem; max-width: 36rem; }
  h3 { font-size: .74rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 .7rem; }
  .steps { list-style: none; margin: 0 0 1.6rem; padding: 0; display: grid; gap: .75rem; }
  .steps li { display: grid; grid-template-columns: 1.9rem 1fr; gap: .7rem; align-items: start; }
  .num { width: 1.9rem; height: 1.9rem; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 800; font-size: .85rem; display: inline-flex; align-items: center; justify-content: center; }
  .steps strong { display: block; font-size: .92rem; margin-bottom: .15rem; }
  .steps span { color: var(--muted); font-size: .85rem; line-height: 1.5; }
  .chips { display: flex; flex-wrap: wrap; gap: .45rem; margin: 0 0 1.4rem; padding: 0; list-style: none; }
  .chips li { border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: .28rem .7rem; font-size: .8rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.1rem 1.2rem; margin-bottom: .9rem; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
  .card.success { border-color: var(--ok); }
  h2 { margin: 0 0 .5rem; font-size: 1rem; }
  p { margin: 0 0 .8rem; font-size: .85rem; line-height: 1.45; }
  .card p:last-child { margin-bottom: 0; }
  .hint { color: var(--muted); font-size: .78rem; }
  .qr { display: flex; justify-content: center; padding: .5rem 0; }
  .qr svg { width: 180px; height: 180px; }
  .secret { display: block; text-align: center; font-family: ui-monospace, monospace; font-size: .82rem; letter-spacing: .08em; background: var(--bg); border-radius: 8px; padding: .5rem; margin: .4rem 0 .7rem; user-select: all; overflow-wrap: anywhere; }
  form { display: flex; gap: .5rem; }
  input[type="text"] { flex: 1; min-width: 0; font: inherit; font-size: 1.15rem; letter-spacing: .35em; text-align: center; padding: .55rem .4rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: inherit; }
  input[type="text"]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  button { font: inherit; font-weight: 700; padding: .55rem 1rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  button:hover { filter: brightness(.93); }
  button:disabled { opacity: .55; cursor: default; }
  .error { color: #dc2626; font-size: .8rem; margin-top: .6rem; }
  .status .row { display: flex; justify-content: space-between; gap: 1rem; font-size: .82rem; padding: .38rem 0; border-top: 1px solid var(--line); }
  .status .row:first-of-type { border-top: 0; }
  .status .row span:first-child { color: var(--muted); }
  .status .row span:last-child { text-align: right; }
  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; margin-right: .4rem; vertical-align: middle; }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  footer { color: var(--muted); font-size: .76rem; margin-top: 2rem; line-height: 1.5; }
  code { font-family: ui-monospace, monospace; font-size: .92em; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="brand-mark">W</span><span class="brand-name">wikiLLM</span><span class="brand-tag">· workspace knowledge engine</span></div>
  <div class="grid">
    <main>
      <h1>Your documents, turned into a sourced wiki and ready-to-share deliverables.</h1>
      <p class="lead">wikiLLM reads the sources of a project, files them into a wiki where every statement points back to its exact passage, and regenerates your deliverables from templates — with Donna, the assistant, orchestrating the work.</p>
      <h3>What it does</h3>
      <ol class="steps">
        <li><span class="num">1</span><div><strong>Ingest</strong><span>Confluence exports, PDFs and notes are split into one fiche per section, tagged, and grouped into concept families.</span></div></li>
        <li><span class="num">2</span><div><strong>Prove</strong><span>Each fiche cites the exact lines of the archived original; a build freezes the evidence it used, so an export can always be traced.</span></div></li>
        <li><span class="num">3</span><div><strong>Produce</strong><span>Templates and build context become deliverables, then exported and polished with their sources resolved.</span></div></li>
        <li><span class="num">4</span><div><strong>Orchestrate</strong><span>Ask Donna in chat or agent mode: she plans, delegates to the connected agents, and the jobs that change the workspace wait for your approval.</span></div></li>
      </ol>
      <h3>After signing in</h3>
      <ul class="chips">
        <li>Chat &amp; agent mode</li><li>Wiki browser &amp; graph</li><li>Execution graph</li><li>Plan · Files · Logs</li><li>Curation reviews</li><li>Help</li>
      </ul>
    </main>
    <aside class="side">
      ${loginCard}
      <section class="card status" aria-label="Service status">
        <h2>Status</h2>
        ${statusRows({ about, enrolled, enabled, tls })}
      </section>
      <p class="hint">One session covers the ShellUI and the served wiki. First login? Run <code>wiki-manager login</code> on the machine that hosts the manager — enrollment is only offered there.</p>
    </aside>
  </div>
  <footer>Local-first, single-user: sources, wiki, deliverables and history stay in your workspace folders; only model calls leave this machine, to the provider you configured.</footer>
</div>
<script>
(function () {
  var form = document.getElementById('login-form');
  if (!form) return;
  var input = document.getElementById('code');
  var submit = document.getElementById('submit');
  var error = document.getElementById('error');
  input.addEventListener('input', function () {
    input.value = input.value.replace(/\\D/g, '').slice(0, 6);
  });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var code = input.value.replace(/\\D/g, '');
    if (code.length !== 6) return;
    submit.disabled = true;
    error.hidden = true;
    try {
      var response = await fetch('/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (response.ok && payload.ok) {
        document.getElementById('login-card').outerHTML = payload.page;
      } else {
        error.textContent = payload.error || 'Verification failed.';
        error.hidden = false;
        input.value = '';
        input.focus();
      }
    } catch (err) {
      error.textContent = 'The login service is not answering.';
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
}
