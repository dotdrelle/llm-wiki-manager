// Live resource use of a workspace's containers — one line in serve's Run
// execution view, the sum of `docker stats` over the workspace's own Compose
// project (wiki, serve, mcp-http, production-mcp; the shared agents stack is
// another project and serves every workspace).
//
// Built so that watching costs almost nothing and never spams Docker:
// - ONE streaming `docker stats` process per watched workspace. Docker pushes
//   a sample about once a second on that stream; nothing is spawned per
//   sample, and the latest sample per container is kept in memory.
// - Started by the first request, stopped after `idleMs` without one: a view
//   nobody looks at (closed, hidden tab, closed browser) costs nothing.
// - Every reader gets the same in-memory snapshot: ten open tabs still mean
//   one `docker stats`.
// - The container list is re-read every `listEveryMs`; the stream restarts
//   only when that list changes.
// - Nothing goes to the event stream or SQLite: a stats tick is not an event.
// A Docker that cannot answer is reported (`state: 'unavailable'`, `error`),
// never shown as an empty line.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceProjectName } from '../core/compose.js';

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SIZE_UNITS = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

export function parseDockerSize(text) {
  const match = String(text ?? '').trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/);
  if (!match) return 0;
  const unit = SIZE_UNITS[(match[2] || 'b').toLowerCase()];
  return unit ? Math.round(Number(match[1]) * unit) : 0;
}

function parsePercent(text) {
  const value = Number(String(text ?? '').replace('%', '').trim());
  return Number.isFinite(value) ? value : 0;
}

function parsePair(text) {
  const [left, right] = String(text ?? '').split('/');
  return [parseDockerSize(left), parseDockerSize(right)];
}

// One `docker stats --format '{{json .}}'` line → a sample, or null.
export function parseStatsLine(line) {
  const clean = String(line ?? '').replace(ANSI_ESCAPE, '').trim();
  if (!clean.startsWith('{')) return null;
  try {
    const raw = JSON.parse(clean);
    const name = String(raw.Name ?? raw.Container ?? raw.ID ?? '').trim();
    if (!name || name === '--') return null;
    const [memUsed, memLimit] = parsePair(raw.MemUsage);
    const [netRx, netTx] = parsePair(raw.NetIO);
    return {
      name,
      cpuPercent: parsePercent(raw.CPUPerc),
      memUsedBytes: memUsed,
      memLimitBytes: memLimit,
      netRxBytes: netRx,
      netTxBytes: netTx,
      pids: Number(raw.PIDs) || 0,
    };
  } catch {
    return null;
  }
}

// The one line: CPU, memory and network summed over the containers. The
// memory limit docker reports per container is the host's (or the container's
// own cap), so the largest one is shown, never their sum.
export function summarizeSamples(samples) {
  const list = [...samples];
  const sum = (key) => list.reduce((total, sample) => total + (sample[key] || 0), 0);
  return {
    containers: list.length,
    cpuPercent: Math.round(sum('cpuPercent') * 10) / 10,
    memUsedBytes: sum('memUsedBytes'),
    memLimitBytes: list.reduce((max, sample) => Math.max(max, sample.memLimitBytes || 0), 0),
    netRxBytes: sum('netRxBytes'),
    netTxBytes: sum('netTxBytes'),
    pids: sum('pids'),
    perContainer: list
      .map((sample) => ({ name: sample.name, cpuPercent: sample.cpuPercent, memUsedBytes: sample.memUsedBytes }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function errorText(error) {
  if (error?.code === 'ENOENT') return 'docker command not found';
  const stderr = String(error?.stderr ?? '').trim();
  return (stderr || (error instanceof Error ? error.message : String(error))).split('\n')[0].slice(0, 200);
}

export function createContainerStats({
  spawnImpl = spawn,
  listContainers = async (project) => {
    const { stdout } = await execFileAsync('docker', [
      'ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}',
    ], { timeout: 10_000 });
    return stdout.split('\n').map((name) => name.trim()).filter(Boolean).sort();
  },
  idleMs = 30_000,
  listEveryMs = 30_000,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const watchers = new Map();

  function stopStream(watcher) {
    if (watcher.child) {
      watcher.child.removeAllListeners?.('exit');
      try { watcher.child.kill(); } catch { /* already gone */ }
    }
    watcher.child = null;
  }

  function stop(workspace) {
    const watcher = watchers.get(workspace);
    if (!watcher) return;
    stopStream(watcher);
    if (watcher.timer) clearIntervalImpl(watcher.timer);
    watchers.delete(workspace);
  }

  function startStream(watcher) {
    stopStream(watcher);
    watcher.samples = new Map();
    if (!watcher.names.length) return;
    let child;
    try {
      child = spawnImpl('docker', ['stats', '--format', '{{json .}}', ...watcher.names], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      watcher.error = errorText(error);
      return;
    }
    watcher.child = child;
    let buffer = '';
    let stderr = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const sample = parseStatsLine(line);
        if (!sample || !watcher.names.includes(sample.name)) continue;
        watcher.samples.set(sample.name, sample);
        watcher.sampledAt = now();
        watcher.error = null;
      }
    });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
    child.on('error', (error) => { watcher.error = errorText(error); watcher.child = null; });
    child.on('exit', () => {
      if (watcher.child !== child) return;
      watcher.child = null;
      // Restarted by the next list refresh, which also learns whether the
      // containers went away.
      watcher.error = stderr.trim().split('\n')[0]?.slice(0, 200) || 'docker stats stopped';
      watcher.listedAt = 0;
    });
  }

  async function refreshList(watcher) {
    if (watcher.listing) return;
    watcher.listing = true;
    try {
      const names = await listContainers(watcher.project);
      watcher.listedAt = now();
      const changed = names.join('\n') !== watcher.names.join('\n');
      watcher.names = names;
      if (!names.length) {
        stopStream(watcher);
        watcher.samples = new Map();
        watcher.error = null;
      } else if (changed || !watcher.child) {
        startStream(watcher);
      }
    } catch (error) {
      watcher.listedAt = now();
      watcher.error = errorText(error);
    } finally {
      watcher.listing = false;
    }
  }

  function tick(workspace) {
    const watcher = watchers.get(workspace);
    if (!watcher) return;
    if (now() - watcher.requestedAt > idleMs) { stop(workspace); return; }
    if (now() - watcher.listedAt >= listEveryMs) void refreshList(watcher);
  }

  function snapshot(workspace) {
    let watcher = watchers.get(workspace);
    if (!watcher) {
      watcher = {
        project: workspaceProjectName(workspace),
        names: [],
        samples: new Map(),
        child: null,
        listing: false,
        listedAt: 0,
        requestedAt: now(),
        sampledAt: null,
        error: null,
        timer: null,
      };
      watchers.set(workspace, watcher);
      watcher.timer = setIntervalImpl(() => tick(workspace), Math.min(5_000, idleMs));
      watcher.timer?.unref?.();
      void refreshList(watcher);
    }
    watcher.requestedAt = now();
    const samples = [...watcher.samples.values()];
    const state = watcher.error && !samples.length
      ? 'unavailable'
      : samples.length ? 'live' : watcher.listedAt && !watcher.names.length ? 'empty' : 'starting';
    return {
      ok: true,
      workspace,
      project: watcher.project,
      state,
      error: watcher.error,
      sampledAt: watcher.sampledAt ? new Date(watcher.sampledAt).toISOString() : null,
      ...summarizeSamples(samples),
    };
  }

  return {
    snapshot,
    watching: () => [...watchers.keys()],
    close() {
      for (const workspace of [...watchers.keys()]) stop(workspace);
    },
  };
}
