import { qrSvg } from './qrCode.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*
 The single TOTP login page, served by the runtime. Enrollment shows the QR
 code, the base32 secret and the otpauth:// URI; afterwards the same page is
 a plain 6-digit code form. English UI chrome, like every other manager
 surface. Verifying here also sets the shared `wiki_session` cookie on the
 runtime's origin (server.js), so the same browser reuses the session on
 serve when it runs on this host; serve sets its own cookie when a browser
 reaches it first.
 */
export function loginPageHtml({ enrolled = false, secret = null, uri = null, error = null, sessionExpiresAt = null } = {}) {
  const enrollBlock = !enrolled && secret
    ? `
      <section class="card">
        <h2>Enroll your authenticator</h2>
        <p>Scan the QR code with your authenticator app, or enter the secret manually:</p>
        <div class="qr">${qrSvg(uri)}</div>
        <code class="secret">${escapeHtml(secret)}</code>
        <p class="hint">Manual entry: add an account, choose <strong>TOTP</strong> / time-based code, and paste the secret above.</p>
      </section>`
    : '';
  const successBlock = sessionExpiresAt
    ? `
      <section class="card success">
        <h2>Session active</h2>
        <p>You are signed in until <strong>${escapeHtml(new Date(sessionExpiresAt).toLocaleString())}</strong>.</p>
        <p class="hint">You can close this page.</p>
      </section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wikiLLM — login</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f5f7; color: #1c1f26; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  @media (prefers-color-scheme: dark) { body { background: #12141a; color: #e7e9ee; } }
  .box { width: 100%; max-width: 380px; padding: 1.2rem; }
  .brand { display: flex; align-items: center; gap: .5rem; margin-bottom: 1rem; }
  .brand-mark { width: 2rem; height: 2rem; border-radius: 8px; background: #2563eb; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; }
  .brand-name { font-weight: 700; font-size: 1.05rem; }
  .card { background: #fff; border: 1px solid #d9dce3; border-radius: 12px; padding: 1.1rem 1.2rem; margin-bottom: .9rem; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
  @media (prefers-color-scheme: dark) { .card { background: #1b1e26; border-color: #333843; } }
  .card.success { border-color: #22c55e; }
  h2 { margin: 0 0 .5rem; font-size: 1rem; }
  p { margin: 0 0 .8rem; font-size: .85rem; line-height: 1.45; }
  p:last-child { margin-bottom: 0; }
  .hint { color: #6b7280; font-size: .78rem; }
  .qr { display: flex; justify-content: center; padding: .5rem 0; }
  .qr svg { width: 180px; height: 180px; }
  .secret { display: block; text-align: center; font-family: ui-monospace, monospace; font-size: .82rem; letter-spacing: .08em; background: #f1f2f5; border-radius: 8px; padding: .5rem; margin: .4rem 0 .7rem; user-select: all; }
  @media (prefers-color-scheme: dark) { .secret { background: #111319; } }
  form { display: flex; gap: .5rem; }
  input[type="text"] { flex: 1; min-width: 0; font: inherit; font-size: 1.15rem; letter-spacing: .35em; text-align: center; padding: .55rem .4rem; border: 1px solid #c9cdd6; border-radius: 8px; background: #fff; color: inherit; }
  @media (prefers-color-scheme: dark) { input[type="text"] { background: #12141a; border-color: #3a3f4b; } }
  input[type="text"]:focus { outline: 2px solid #2563eb; outline-offset: 1px; border-color: #2563eb; }
  button { font: inherit; font-weight: 700; padding: .55rem 1rem; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4fd7; }
  button:disabled { opacity: .55; cursor: default; }
  .error { color: #dc2626; font-size: .8rem; margin-top: .6rem; }
</style>
</head>
<body>
<div class="box">
  <div class="brand"><span class="brand-mark">W</span><span class="brand-name">wikiLLM</span></div>
  ${enrollBlock}
  ${successBlock}
  ${sessionExpiresAt ? '' : `
  <form id="login-form" autocomplete="off">
    <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" aria-label="Verification code" autofocus required>
    <button type="submit" id="submit">Verify</button>
  </form>
  <p class="error" id="error" hidden></p>`}
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
        document.querySelector('.box').innerHTML = payload.page;
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

