import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { managerRoot } from './workspaces.js';

const execFileAsync = promisify(execFile);

export const COMPOSE_SERVICES = ['serve', 'mcp-http', 'cme-mcp', 'production-mcp'];

const SERVICE_ALIASES = {
  all: COMPOSE_SERVICES,
  ui: ['serve'],
  serve: ['serve'],
  wiki: ['mcp-http'],
  mcp: ['mcp-http'],
  'mcp-http': ['mcp-http'],
  cme: ['cme-mcp'],
  'cme-mcp': ['cme-mcp'],
  production: ['production-mcp'],
  'production-mcp': ['production-mcp'],
};

function requireWorkspace(session) {
  if (!session.workspace || !session.workspacePath || !session.workspaceEnv?.WORKSPACE_NAME) {
    throw new Error('No workspace loaded. Use /use <workspace>.');
  }
}

function composeFile() {
  return join(managerRoot(), 'docker-compose.yml');
}

function projectName(session) {
  return `wiki-${session.workspace}`.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

function composeBaseArgs(session) {
  const args = ['compose', '-f', composeFile(), '-p', projectName(session)];
  if (session.workspaceEnvFile && existsSync(session.workspaceEnvFile)) {
    args.push('--env-file', session.workspaceEnvFile);
  }
  return args;
}

function composeEnv(session) {
  return {
    ...process.env,
    ...(session.workspaceEnv ?? {}),
    WORKSPACE_NAME: session.workspace,
    WIKI_WORKSPACE_PATH: session.workspacePath,
  };
}

export async function runCompose(session, args, options = {}) {
  requireWorkspace(session);
  const { stdout, stderr } = await execFileAsync(
    'docker',
    [...composeBaseArgs(session), ...args],
    {
      cwd: managerRoot(),
      env: composeEnv(session),
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 4,
      timeout: options.timeout ?? 120_000,
    },
  );
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

export async function listServices(session) {
  const services = await composeServices(session);
  const ps = await composePs(session).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    return `docker compose ps unavailable: ${message}`;
  });
  return [
    'Services:',
    services
      .filter(Boolean)
      .map((service) => `- ${service}`)
      .join('\n'),
    '',
    'Status:',
    ps || 'No running containers.',
  ].join('\n');
}

export async function composeServices(session) {
  const output = await runCompose(session, ['config', '--services'], { timeout: 30_000 });
  return output.split(/\r?\n/).filter(Boolean).sort();
}

export async function composePs(session) {
  return runCompose(session, ['ps'], { timeout: 30_000 });
}

function parseComposePsJson(output) {
  const text = output.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
}

export async function serviceStates(session) {
  const output = await runCompose(session, ['ps', '--format', 'json'], { timeout: 30_000 });
  const entries = parseComposePsJson(output);
  const states = {};
  for (const entry of entries) {
    const service = entry.Service ?? entry.service;
    if (!service) continue;
    const state = String(entry.State ?? entry.state ?? entry.Status ?? entry.status ?? '').toLowerCase();
    states[service] = {
      name: entry.Name ?? entry.name ?? service,
      state,
      running: state.includes('running') || state.includes('up'),
    };
  }
  return states;
}

export async function startService(session, service) {
  const targets = service ? (SERVICE_ALIASES[service] ?? [service]) : COMPOSE_SERVICES;
  const output = await runCompose(session, ['up', '-d', ...targets], { timeout: 180_000 });
  return [`Started: ${targets.join(', ')}`, output].filter(Boolean).join('\n');
}

export async function stopService(session, service) {
  const targets = service ? (SERVICE_ALIASES[service] ?? [service]) : COMPOSE_SERVICES;
  const output = await runCompose(session, ['stop', ...targets], { timeout: 120_000 });
  return [`Stopped: ${targets.join(', ')}`, output].filter(Boolean).join('\n');
}

export async function serviceLogs(session, service, options = {}) {
  if (!service) throw new Error('Usage: /logs <service> [tail]');
  const tail = String(Number.isFinite(options.tail) ? options.tail : 120);
  const output = await runCompose(session, ['logs', '--tail', tail, service], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 8,
  });
  return output || `No logs for ${service}.`;
}

export async function runWikiCli(session, args, options = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('Usage: /wiki run <args...>');
  }
  return runCompose(session, ['run', '--rm', 'wiki', ...args], {
    timeout: options.timeout ?? 180_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
  });
}
