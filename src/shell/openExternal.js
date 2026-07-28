import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// `xdg-open` alone is not an opener strategy. It is absent from most container
// and headless installs, and under WSL it either does not exist or opens a
// Linux browser that nobody can see. Every failure used to be swallowed by an
// empty callback, so clicking a link in the ShellUI did strictly nothing and
// gave no reason why. Try the real candidates for the platform, in order.
function openerCandidates() {
  if (process.platform === 'darwin') return [['open', []]];
  if (process.platform === 'win32') return [['cmd', ['/c', 'start', '']]];
  const candidates = [];
  // WSL: reach the Windows browser first, otherwise the URL opens in a Linux
  // session the operator is not looking at.
  if (process.env.WSL_DISTRO_NAME || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    candidates.push(['wslview', []], ['/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', '']]);
  }
  candidates.push(['xdg-open', []], ['gio', ['open']], ['sensible-browser', []]);
  return candidates;
}

export function normalizeExternalUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Validate, but hand back the operator's own string: `toString()` appends a
    // root slash, so the hint would show `http://localhost:3100/` while the
    // rendered line said `http://localhost:3100`. Safe because the URL is
    // passed as an argv element, never through a shell.
    return text;
  } catch {
    return null;
  }
}

// Returns the opened URL, or null when no opener on this machine worked. The
// caller is expected to fall back to something the operator can act on (copy
// the URL, show it) rather than failing silently.
export function openExternalUrl(value, { run = execFileSync } = {}) {
  const url = normalizeExternalUrl(value);
  if (!url) return null;
  for (const [command, args] of openerCandidates()) {
    try {
      run(command, [...args, url], { stdio: 'ignore', timeout: 5_000 });
      return url;
    } catch {
      // Missing binary or non-zero exit: try the next candidate.
    }
  }
  return null;
}
