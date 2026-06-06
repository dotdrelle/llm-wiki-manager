import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { managerEnvFile, readEnvFile } from './env.js';
import { managerRoot } from './workspaces.js';

const execFileAsync = promisify(execFile);

export const COMPOSE_SERVICES = ['serve', 'mcp-http', 'cme-mcp', 'production-mcp'];
const SERVICE_DESCRIPTION_LABEL = 'wiki-manager.description';

const DEFAULT_SERVICE_ALIASES = {
  all: COMPOSE_SERVICES,
  ui: ['serve'],
  wiki: ['mcp-http'],
  mcp: ['mcp-http'],
  cme: ['cme-mcp'],
  production: ['production-mcp'],
};

function requireWorkspace(session) {
  if (!session.workspace || !session.workspacePath || !session.workspaceEnv?.WORKSPACE_NAME) {
    throw new Error('No workspace loaded. Use /use <workspace>.');
  }
}

function composeFile() {
  return join(managerRoot(), 'docker-compose.yml');
}

function readManagerEnv() {
  const envPath = managerEnvFile();
  return existsSync(envPath) ? readEnvFile(envPath) : {};
}

function readComposeConfig() {
  try {
    return YAML.parse(readFileSync(composeFile(), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function normalizeLabels(labels) {
  if (!labels) return {};
  if (!Array.isArray(labels)) return labels;
  return Object.fromEntries(
    labels.flatMap((entry) => {
      const text = String(entry ?? '');
      const index = text.indexOf('=');
      return index > 0 ? [[text.slice(0, index), text.slice(index + 1)]] : [];
    }),
  );
}

function composeAliasMetadata() {
  return readComposeConfig()?.['x-wiki-manager']?.['service-aliases'] ?? {};
}

function serviceAliases() {
  const aliases = { ...DEFAULT_SERVICE_ALIASES };
  for (const [name, value] of Object.entries(composeAliasMetadata())) {
    const targets = Array.isArray(value?.targets) ? value.targets.map(String).filter(Boolean) : [];
    if (targets.length > 0) aliases[name] = targets;
  }
  return aliases;
}

function serviceDescriptions() {
  const config = readComposeConfig();
  const descriptions = {};
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const labels = normalizeLabels(service?.labels);
    if (labels[SERVICE_DESCRIPTION_LABEL]) descriptions[name] = String(labels[SERVICE_DESCRIPTION_LABEL]);
  }
  for (const [name, value] of Object.entries(composeAliasMetadata())) {
    if (value?.description) descriptions[name] = String(value.description);
  }
  return descriptions;
}

export function serviceNames() {
  return [...new Set([...COMPOSE_SERVICES, ...Object.keys(serviceAliases())])].sort();
}

export function serviceDescription(name) {
  return serviceDescriptions()[name] ?? null;
}

function projectName(session) {
  return `wiki-${session.workspace}`.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

function composeBaseArgs(session) {
  const args = ['compose', '-f', composeFile(), '-p', projectName(session)];
  const managerEnvPath = managerEnvFile();
  if (existsSync(managerEnvPath)) {
    args.push('--env-file', managerEnvPath);
  }
  if (session.workspaceEnvFile && existsSync(session.workspaceEnvFile)) {
    args.push('--env-file', session.workspaceEnvFile);
  }
  return args;
}

function composeEnv(session) {
  return {
    ...process.env,
    ...readManagerEnv(),
    ...(session.workspaceEnv ?? {}),
    WORKSPACE_NAME: session.workspace,
    WIKI_WORKSPACE_PATH: session.workspacePath,
  };
}

export async function runCompose(session, args, options = {}) {
  requireWorkspace(session);
  if (typeof options.onOutput === 'function') {
    return runComposeStreaming(session, args, options);
  }
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

function emitLines(buffer, chunk, onLine) {
  const text = buffer + chunk;
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) onLine(line);
  }
  return rest;
}

async function runComposeStreaming(session, args, options = {}) {
  const composeArgs = [...composeBaseArgs(session), ...args];
  const chunks = [];
  const timeout = options.timeout ?? 120_000;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024 * 4;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', composeArgs, {
      cwd: managerRoot(),
      env: composeEnv(session),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let outputSize = 0;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms: docker ${composeArgs.join(' ')}`));
    }, timeout);

    const collect = (source) => (chunk) => {
      const text = chunk.toString();
      chunks.push(text);
      outputSize += text.length;
      if (outputSize > maxBuffer) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new Error(`Command output exceeded maxBuffer: docker ${composeArgs.join(' ')}`));
        return;
      }
      if (source === 'stderr') {
        stderrBuffer = emitLines(stderrBuffer, text, options.onOutput);
      } else {
        stdoutBuffer = emitLines(stdoutBuffer, text, options.onOutput);
      }
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const line of [stdoutBuffer, stderrBuffer]) {
        if (line.trim()) options.onOutput(line);
      }
      const output = chunks.join('').trim();
      if (code === 0) {
        resolve(output);
      } else {
        const err = new Error(`Command failed: docker ${composeArgs.join(' ')}\n${output}`);
        err.code = code;
        reject(err);
      }
    });
  });
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
  const aliases = serviceAliases();
  const targets = service ? (aliases[service] ?? [service]) : COMPOSE_SERVICES;
  const output = await runCompose(session, ['up', '-d', ...targets], { timeout: 180_000 });
  return [`Started: ${targets.join(', ')}`, output].filter(Boolean).join('\n');
}

export async function stopService(session, service) {
  const aliases = serviceAliases();
  const targets = service ? (aliases[service] ?? [service]) : COMPOSE_SERVICES;
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
    onOutput: options.onOutput,
  });
}
