import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function userManagerDir() {
  return process.cwd();
}

export function managerStateDir() {
  return process.env.WIKI_MANAGER_ENV_FILE
    ? dirname(resolve(process.env.WIKI_MANAGER_ENV_FILE))
    : userManagerDir();
}

export function managerRuntimeDir() {
  return join(managerStateDir(), '.wiki-manager');
}

export function defaultRuntimeStateDir() {
  return process.env.WIKI_MANAGER_STATE_DIR
    ? resolve(process.env.WIKI_MANAGER_STATE_DIR)
    : managerRuntimeDir();
}

export function managerEnvFile() {
  return process.env.WIKI_MANAGER_ENV_FILE
    ? resolve(process.env.WIKI_MANAGER_ENV_FILE)
    : join(managerStateDir(), '.env');
}

export function managerMcpEndpointsFile() {
  return join(managerStateDir(), 'mcp.endpoints.json');
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// First-run scaffolding: a fresh install directory has neither
// mcp.endpoints.json nor .env, so the external agents (cme, mailer,
// documents) silently never connect — /status shows no agents and Donna has
// no CME tools to configure anything with. Copy the packaged examples so a
// fresh directory works out of the box with the default agent ports. Optional
// credentials can be added later for the external services the user enables.
export function ensureManagerScaffold({ log = () => {} } = {}) {
  const created = [];
  const endpointsFile = managerMcpEndpointsFile();
  const endpointsExample = join(packageRoot, 'mcp.endpoints.example.json');
  if (!existsSync(endpointsFile) && existsSync(endpointsExample)) {
    copyFileSync(endpointsExample, endpointsFile);
    created.push('mcp.endpoints.json');
  }
  const envFile = managerEnvFile();
  const envExample = join(packageRoot, '.env.example');
  if (!existsSync(envFile) && existsSync(envExample)) {
    // Substitute the documentation placeholders with real paths: a copied
    // WORKSPACES_ROOT=/path/to/workspaces silently broke agents compose
    // mounts until manually edited.
    const workspacesRoot = join(managerStateDir(), 'workspaces');
    const content = readFileSync(envExample, 'utf8')
      .replace(/^WORKSPACES_ROOT=.*$/m, `WORKSPACES_ROOT=${workspacesRoot}`)
      .replace(/^# WIKI_WORKSPACES_DIR=.*$/m, `WIKI_WORKSPACES_DIR=${workspacesRoot}`);
    writeFileSync(envFile, content);
    created.push('.env');
  }
  if (created.length > 0) {
    log(`configuration initialized successfully in ${managerStateDir()} — created ${created.join(' and ')} from packaged defaults. Optional credentials can be added later for external services.`);
  }
  return created;
}

// Single source of truth for where `.agents-data` lives, shared by the
// manager's own document intake and by the host path it mounts into agent
// containers — keeping them in sync avoids the two silently drifting apart.
export function resolveAgentsDataDir(session = null) {
  const configured = process.env.AGENTS_DATA_DIR;
  if (configured) return isAbsolute(configured) ? configured : resolve(defaultRuntimeStateDir(), configured);
  if (session?.workspacePath) return resolve(dirname(session.workspacePath), '.agents-data');
  return resolve(defaultRuntimeStateDir(), 'agents-data');
}

function parseEnvValue(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\nrt])/g, (_match, char) => {
        if (char === 'n') return '\n';
        if (char === 'r') return '\r';
        if (char === 't') return '\t';
        return char;
      });
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadManagerEnv() {
  const filePath = managerEnvFile();
  if (!existsSync(filePath)) return;
  const values = readEnvFile(filePath);
  for (const [key, value] of Object.entries(values)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function readEnvFile(filePath) {
  const values = {};
  const raw = readFileSync(filePath, 'utf8');
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    values[key] = parseEnvValue(value);
  }
  return values;
}
