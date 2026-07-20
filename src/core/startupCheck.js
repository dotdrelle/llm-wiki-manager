import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { activeCacertPath, cacertEnv } from './cacert.js';
import { COMPOSE_SERVICES, parseComposePsJson, serviceStates } from './compose.js';
import { buildMcpStatus, discoverMcpTools } from './mcp.js';
import { listWikircProfiles, loadWikircProfile, summarizeWikircConfig } from './wikirc.js';
import { listWorkspaces, managerRoot, workspacesDir } from './workspaces.js';

const execFileAsync = promisify(execFile);
const DEFAULT_CONNECTIVITY_URL = 'https://registry.npmjs.org/-/ping';

function commandError(err) {
  return String(err?.stderr ?? err?.stdout ?? err?.message ?? err ?? 'unknown error').trim();
}

function dockerFailure(err) {
  if (err?.code === 'ENOENT') return { ok: false, context: { dockerMissing: true } };
  const detail = commandError(err);
  const unavailable = /Cannot connect to the Docker daemon|Is the docker daemon running|docker daemon|connection refused/i.test(detail);
  return {
    ok: false,
    context: unavailable
      ? { dockerUnavailable: true, dockerError: detail }
      : { dockerUnavailable: true, dockerError: detail || 'Docker availability check failed.' },
  };
}

export async function checkDockerAvailability({ exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{json .ServerVersion}}'], {
      cwd: managerRoot(),
      env: process.env,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: String(stdout ?? '').trim().replace(/^"|"$/g, '') || 'available' };
  } catch (err) {
    return dockerFailure(err);
  }
}

export async function checkInternetConnectivity({
  exec = execFileAsync,
  url = process.env.WIKI_MANAGER_CONNECTIVITY_URL ?? DEFAULT_CONNECTIVITY_URL,
  timeoutMs = 7000,
} = {}) {
  const cacertPath = activeCacertPath();
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null;
  const proxyEnabled = process.env.NODE_USE_ENV_PROXY === '1';
  if (cacertPath && !existsSync(cacertPath)) {
    return {
      ok: false,
      context: { url, error: `CA certificate not found: ${cacertPath}`, cacertPath, proxyUrl, proxyEnabled },
    };
  }
  const node = process.versions.bun ? (process.env.WIKI_MANAGER_NODE_BIN ?? 'node') : process.execPath;
  const script = [
    'const controller = new AbortController();',
    `const timer = setTimeout(() => controller.abort(), ${Math.max(1000, Number(timeoutMs) || 7000)});`,
    "try { const response = await fetch(process.argv[1], { method: 'GET', signal: controller.signal }); if (!response.ok) throw new Error('HTTP ' + response.status); } finally { clearTimeout(timer); }",
  ].join(' ');
  try {
    await exec(node, ['--input-type=module', '-e', script, url], {
      cwd: managerRoot(),
      // Run in a fresh Node process so both environment-proxy support and a
      // custom CA are applied at process startup, just like the runtime.
      env: { ...process.env, ...cacertEnv(cacertPath) },
      timeout: Math.max(2000, Number(timeoutMs) + 1000),
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: url, context: { url, cacertPath, proxyUrl, proxyEnabled } };
  } catch (err) {
    return {
      ok: false,
      context: { url, error: commandError(err) || 'Internet connectivity check failed.', cacertPath, proxyUrl, proxyEnabled },
    };
  }
}

async function checkAgents({ exec = execFileAsync } = {}) {
  const composeFile = join(managerRoot(), 'agents.docker-compose.yml');
  if (!existsSync(composeFile)) return null;
  try {
    const { stdout } = await exec('docker', [
      'compose',
      '--project-directory',
      managerRoot(),
      '-f',
      composeFile,
      '-p',
      'wiki-agents',
      'ps',
      '--format',
      'json',
    ], {
      cwd: managerRoot(),
      env: {
        ...process.env,
        WORKSPACES_ROOT: workspacesDir(),
        WIKI_WORKSPACES_DIR: workspacesDir(),
      },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const entries = parseComposePsJson(stdout);
    if (entries.length === 0) return null;
    const downServices = entries
      .filter((entry) => {
        const state = String(entry.State ?? entry.state ?? entry.Status ?? entry.status ?? '').toLowerCase();
        return !(state.includes('running') || state.includes('up'));
      })
      .map((entry) => entry.Service ?? entry.service ?? entry.Name ?? entry.name)
      .filter(Boolean);
    return downServices.length > 0 ? { kind: 'agents', context: { downServices } } : null;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { kind: 'agents', context: { dockerMissing: true } };
    }
    const stderr = String(err?.stderr ?? err?.message ?? '');
    if (
      stderr.includes('Cannot connect to the Docker daemon') ||
      stderr.includes('Is the docker daemon running') ||
      stderr.includes('docker daemon') ||
      stderr.includes('connection refused')
    ) {
      return { kind: 'agents', context: { dockerUnavailable: true } };
    }
    // Timeout or unknown error — don't block startup with ambiguous state.
    return null;
  }
}

function checkWorkspace(workspaces) {
  return workspaces.length === 0 ? { kind: 'workspace' } : null;
}

function checkWikirc(workspace) {
  if (!workspace) return [];
  const baseContext = {
    workspaceName: workspace.name,
    workspacePath: workspace.workspacePath,
    profileName: 'default',
  };
  if (listWikircProfiles(workspace.workspacePath).length === 0) {
    return [
      {
        kind: 'llm',
        context: {
          ...baseContext,
          configError: 'No .wikirc.yaml profile found in the workspace.',
        },
      },
    ];
  }
  try {
    const loaded = loadWikircProfile(workspace.workspacePath, 'default');
    const summary = summarizeWikircConfig(loaded.profile, loaded.config);
    const context = {
      workspaceName: workspace.name,
      workspacePath: workspace.workspacePath,
      profileName: loaded.profile.name,
    };
    const gaps = [];
    if (!summary.provider || !summary.baseUrl || !summary.hasApiKey || !summary.model) gaps.push({ kind: 'llm', context });
    if (!summary.vectorEnabled) gaps.push({ kind: 'vector', context });
    return gaps;
  } catch {
    return [
      {
        kind: 'llm',
        context: {
          ...baseContext,
          configError: 'Default .wikirc.yaml profile could not be loaded.',
        },
      },
      {
        kind: 'vector',
        context: {
          ...baseContext,
          configError: 'Default .wikirc.yaml profile could not be loaded.',
        },
      },
    ];
  }
}

function startupSession(workspace) {
  const session = {
    workspace: workspace.name,
    workspacePath: workspace.workspacePath,
    workspaceEnvFile: workspace.envFile,
    workspaceEnv: workspace.env,
    wikirc: null,
    wikircConfig: null,
  };
  try {
    const loaded = loadWikircProfile(workspace.workspacePath, 'default');
    session.wikirc = {
      profile: loaded.profile.name,
      fileName: loaded.profile.fileName,
      path: loaded.profile.path,
    };
    session.wikircConfig = loaded.config;
  } catch { /* configuration gap is reported separately */ }
  return session;
}

export async function checkWorkspaceContainers(workspace) {
  try {
    const states = await serviceStates(startupSession(workspace));
    const unavailable = COMPOSE_SERVICES.filter((name) => !states[name]?.running);
    return {
      ok: unavailable.length === 0,
      pending: unavailable.length > 0,
      detail: unavailable.length === 0 ? `${COMPOSE_SERVICES.length} running` : `To start: ${unavailable.join(', ')}`,
      context: { states, unavailable, command: `wiki-workspace up ${workspace.name}` },
    };
  } catch (err) {
    return {
      ok: false,
      pending: true,
      detail: 'Workspace containers remain to be started',
      context: { error: commandError(err), command: `wiki-workspace up ${workspace.name}` },
    };
  }
}

function isLocalEndpoint(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'host.docker.internal';
  } catch {
    return false;
  }
}

function mcpFailureKind(value) {
  if (value.status === 'missing') return 'configuration';
  const message = String(value.toolError ?? '');
  if (/\b(401|403|unauthorized|forbidden)\b/i.test(message)) return 'authentication';
  if (/initialize|json|protocol|parse|session id/i.test(message)) return 'protocol';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout|aborted|socket/i.test(message)) return 'unreachable';
  return 'unavailable';
}

export async function checkMcpConnections(workspace, {
  internetAvailable = true,
  buildStatus = buildMcpStatus,
  discover = discoverMcpTools,
} = {}) {
  let configured;
  try {
    configured = buildStatus(startupSession(workspace));
  } catch (err) {
    return {
      ok: false,
      detail: 'MCP configuration invalid',
      context: { error: commandError(err), endpoints: [] },
    };
  }
  const skipped = {};
  const candidates = {};
  for (const [name, endpoint] of Object.entries(configured)) {
    if (!internetAvailable && endpoint.external && !isLocalEndpoint(endpoint.url)) {
      skipped[name] = { ...endpoint, tools: [], toolError: 'Skipped: Internet unavailable', preflightSkipped: true };
    } else {
      candidates[name] = endpoint;
    }
  }
  let discovered;
  try {
    discovered = await discover(candidates);
  } catch (err) {
    return {
      ok: false,
      detail: 'MCP handshake failed',
      context: { error: commandError(err), endpoints: [] },
    };
  }
  const endpoints = { ...discovered, ...skipped };
  const details = Object.entries(endpoints).map(([name, value]) => ({
    name,
    status: value.preflightSkipped ? 'skipped' : value.status === 'connected' ? 'connected' : 'failed',
    tools: Array.isArray(value.tools) ? value.tools.length : 0,
    reason: value.preflightSkipped ? 'internet unavailable' : value.status === 'connected' ? null : mcpFailureKind(value),
    error: value.toolError ?? value.detail ?? null,
  }));
  const connected = details.filter((item) => item.status === 'connected');
  const failed = details.filter((item) => item.status === 'failed');
  const skippedCount = details.filter((item) => item.status === 'skipped').length;
  return {
    ok: failed.length === 0,
    pending: failed.length > 0 || skippedCount > 0,
    detail: `${connected.length} connected${failed.length ? `, ${failed.length} pending` : ''}${skippedCount ? `, ${skippedCount} waiting for Internet` : ''}`,
    context: { endpoints: details, command: '/mcp status' },
  };
}

function preflightStatus(gaps, checks) {
  const setupRequired = gaps.some((gap) => gap.kind === 'workspace' || gap.kind === 'llm');
  if (setupRequired) return 'setup_required';
  return checks.every((check) => check.ok || check.skipped) ? 'ready' : 'degraded';
}

function compactNames(names, limit = 6) {
  const visible = names.slice(0, limit);
  return `${visible.join(', ')}${names.length > limit ? ` +${names.length - limit} more` : ''}`;
}

function compactContainerSummary(results, pending) {
  if (pending.length === 0) {
    return `${results.length}/${results.length} workspaces running: ${compactNames(results.map((item) => item.workspace.name))}`;
  }
  const groups = new Map();
  for (const item of pending) {
    const services = item.result.context?.unavailable?.length
      ? item.result.context.unavailable.join(', ')
      : 'services';
    const names = groups.get(services) ?? [];
    names.push(item.workspace.name);
    groups.set(services, names);
  }
  const grouped = [...groups.entries()].slice(0, 3).map(([services, names]) =>
    `${compactNames(names, 4)} — services: ${services}`);
  const hiddenGroups = groups.size > 3 ? `; +${groups.size - 3} service group(s)` : '';
  return `${pending.length}/${results.length} workspaces to start: ${grouped.join('; ')}${hiddenGroups}`;
}

export async function runChecks({
  dockerCheck = checkDockerAvailability,
  internetCheck = checkInternetConnectivity,
  agentsCheck = checkAgents,
  workspaceContainersCheck = checkWorkspaceContainers,
  mcpCheck = checkMcpConnections,
  onCheck = () => {},
} = {}) {
  // Keep infrastructure checks first and sequential: the order is part of the
  // startup contract and makes proxy/CA diagnostics understandable.
  const docker = await dockerCheck();
  onCheck({ kind: 'docker', ...docker });
  const internet = await internetCheck();
  onCheck({ kind: 'internet', ...internet });

  const workspaces = [...listWorkspaces()].sort((a, b) => a.name.localeCompare(b.name));
  const agents = docker.ok ? await agentsCheck() : null;
  const gaps = [];
  if (!docker.ok) gaps.push({ kind: 'agents', context: docker.context ?? { dockerUnavailable: true } });
  if (!internet.ok) gaps.push({ kind: 'network', context: internet.context ?? {} });
  if (agents) gaps.push(agents);
  onCheck({
    kind: 'agents',
    ok: docker.ok && !agents,
    skipped: !docker.ok,
    pending: !docker.ok || Boolean(agents),
    detail: !docker.ok
      ? 'Waiting for Docker'
      : agents?.context?.downServices?.length
        ? `To start: ${agents.context.downServices.join(', ')}`
        : 'Running',
    context: { ...(agents?.context ?? {}), command: 'wiki-workspace agents up' },
  });
  const workspaceGap = checkWorkspace(workspaces);
  if (workspaceGap) {
    gaps.push(workspaceGap);
    onCheck({ kind: 'workspace', ok: false, detail: 'No valid workspace initialization' });
    onCheck({ kind: 'containers', ok: false, skipped: true, pending: true, detail: 'Waiting for workspace initialization' });
    onCheck({ kind: 'mcp', ok: false, skipped: true, pending: true, detail: 'Waiting for workspace initialization' });
    return gaps;
  }
  const workspaceChecks = workspaces.map((workspace) => ({ workspace, gaps: checkWikirc(workspace) }));
  const wikircGaps = workspaceChecks.flatMap((item) => item.gaps);
  const invalidWorkspaces = workspaceChecks
    .filter((item) => item.gaps.some((gap) => gap.kind === 'llm'))
    .map((item) => item.workspace.name);
  gaps.push(...wikircGaps);
  onCheck({
    kind: 'workspace',
    ok: invalidWorkspaces.length === 0,
    pending: invalidWorkspaces.length > 0,
    detail: `${workspaces.length} registered: ${compactNames(workspaces.map((workspace) => workspace.name))}${invalidWorkspaces.length ? ` — configuration pending: ${compactNames(invalidWorkspaces)}` : ''}`,
    context: { workspaces: workspaces.map((workspace) => workspace.name), invalidWorkspaces },
  });
  if (!docker.ok) {
    onCheck({
      kind: 'containers',
      ok: false,
      skipped: true,
      pending: true,
      detail: `Waiting for Docker — ${workspaces.length} workspace(s) to check`,
      context: { command: `wiki-workspace up ${workspaces[0].name}` },
    });
  } else {
    const results = await Promise.all(workspaces.map(async (workspace) => ({
      workspace,
      result: await workspaceContainersCheck(workspace),
    })));
    const pending = results.filter((item) => !item.result.ok);
    onCheck({
      kind: 'containers',
      ok: pending.length === 0,
      pending: pending.length > 0,
      detail: compactContainerSummary(results, pending),
      context: {
        workspaces: results.map((item) => ({ name: item.workspace.name, ...item.result })),
        unavailable: pending.flatMap((item) => item.result.context?.unavailable ?? []),
        command: pending[0]?.result.context?.command ?? `wiki-workspace up ${pending[0]?.workspace.name ?? workspaces[0].name}`,
      },
    });
  }
  // MCP endpoints are independent connections. Keep probing them even when
  // Docker is down: a remote or host-native MCP may still be healthy, while
  // local container-backed endpoints will report their own reachability.
  const mcpResults = await Promise.all(workspaces.map(async (workspace) => ({
    workspace,
    result: await mcpCheck(workspace, { internetAvailable: internet.ok }),
  })));
  const mcpPending = mcpResults.filter((item) => !item.result.ok);
  const endpointChecks = mcpResults.flatMap((item) =>
    (item.result.context?.endpoints ?? []).map((endpoint) => ({ workspace: item.workspace.name, ...endpoint })));
  const connectedEndpoints = endpointChecks.filter((endpoint) => endpoint.status === 'connected').length;
  const pendingEndpoints = endpointChecks.filter((endpoint) => endpoint.status === 'failed').length;
  const skippedEndpoints = endpointChecks.filter((endpoint) => endpoint.status === 'skipped').length;
  onCheck({
    kind: 'mcp',
    ok: mcpPending.length === 0,
    pending: mcpPending.length > 0 || skippedEndpoints > 0,
    detail: `${workspaces.length} workspace(s) checked — ${connectedEndpoints} connected${pendingEndpoints ? `, ${pendingEndpoints} pending` : ''}${skippedEndpoints ? `, ${skippedEndpoints} waiting for Internet` : ''}`,
    context: {
      endpoints: endpointChecks,
      command: `/use ${mcpPending[0]?.workspace.name ?? workspaces[0].name}, then /mcp status`,
    },
  });
  return gaps;
}

export async function runPreflightChecks(options = {}) {
  const checks = [];
  const externalOnCheck = options.onCheck;
  const gaps = await runChecks({
    ...options,
    onCheck: (check) => {
      checks.push(check);
      externalOnCheck?.(check);
    },
  });
  return { gaps, checks, status: preflightStatus(gaps, checks) };
}

export function withRuntimePreflight(preflight, runtime) {
  const runtimeCheck = runtime?.url
    ? { kind: 'runtime', ok: true, detail: runtime.started ? 'Started' : 'Connected' }
    : { kind: 'runtime', ok: false, detail: runtime?.error ?? 'Unavailable' };
  const checks = [...(preflight?.checks ?? []).filter((check) => check.kind !== 'runtime'), runtimeCheck];
  return {
    ...(preflight ?? { gaps: [] }),
    checks,
    status: preflight?.status === 'setup_required'
      ? 'setup_required'
      : checks.every((check) => check.ok || check.skipped) ? 'ready' : 'degraded',
  };
}
