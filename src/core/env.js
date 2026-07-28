import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  const root = managerStateDir();
  const runtimeDir = join(root, '.wiki', 'runtime');
  const legacyDir = join(root, '.wiki-manager');
  if (!existsSync(runtimeDir) && existsSync(legacyDir)) {
    mkdirSync(join(root, '.wiki'), { recursive: true });
    renameSync(legacyDir, runtimeDir);
  }
  return runtimeDir;
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

// User-owned compose overrides, one per stack, next to the manager .env.
// Deliberately NOT under .wiki/runtime: everything there is generated state
// that every compose command rewrites (see cacert.js). These two are seeded
// once and never touched again, so an operator has a supported place to fix a
// deployment — proxy passthrough, extra mounts, optional agents — instead of
// editing a generated file and losing the change on the next command.
export const COMPOSE_OVERRIDES = [
  { example: 'docker-compose.override.example.yml', target: 'docker-compose.override.yml' },
  { example: 'agents.docker-compose.override.example.yml', target: 'agents.docker-compose.override.yml' },
];

export function managerComposeOverrideFile(target = 'docker-compose.override.yml') {
  return join(managerStateDir(), target);
}

// Keys the deployment cannot work without. `.env.example` ships them active,
// but the scaffold only copies that file on first run, so installs predating a
// new required key never receive it — the same additive-migration gap the
// endpoints file had.
export const REQUIRED_ENV_KEYS = {
  // `serve` runs in Docker and calls the host runtime through
  // host.docker.internal. A runtime bound to 127.0.0.1 refuses that connection,
  // and the workspace UI silently shows no runtime. Exposing the port always
  // generates a token (see resolveRuntimeAuthToken), so this is not an
  // unauthenticated bind.
  WIKI_MANAGER_RUNTIME_HOST: '0.0.0.0',
};

function commentedAssignment(line, key) {
  return new RegExp(`^\\s*#+\\s*${key}=`).test(line);
}

// Mirrors set_env_value in wiki-workspace: reuse the commented placeholder so
// the value lands under the comment block that documents it, and never
// overwrite an active assignment — that one is the operator's own choice.
export function writeEnvValueIfMissing(filePath, key, value) {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  if (lines.some((line) => line.startsWith(`${key}=`))) return false;
  const placeholder = lines.findIndex((line) => commentedAssignment(line, key));
  if (placeholder >= 0) lines[placeholder] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(filePath, lines.join('\n'));
  return true;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// First-run scaffolding: a fresh install directory has neither
// mcp.endpoints.json nor .env, so the external agents (cme and documents)
// silently never connect — /status shows no agents and Donna has
// no CME tools to configure anything with. Copy the packaged examples so a
// fresh directory works out of the box with the default agent ports. Optional
// credentials can be added later for the external services the user enables.
export function ensureManagerScaffold({ log = () => {} } = {}) {
  const created = [];
  const endpointsFile = managerMcpEndpointsFile();
  const endpointsExample = join(packageRoot, 'mcp.endpoints.example.json');
  if (existsSync(endpointsExample)) {
    if (!existsSync(endpointsFile)) {
      copyFileSync(endpointsExample, endpointsFile);
      created.push('mcp.endpoints.json');
    } else {
      // Additive migration: the scaffold only copies the example on first run,
      // so installs that predate a new top-level key (e.g. chatAccess) never
      // receive it and the feature stays silently disabled. Merge ONLY the
      // top-level keys missing from the operator's file; existing keys —
      // including a hand-edited chatAccess — are never touched. To disable a
      // feature key permanently, set it to null instead of deleting it: null is
      // "present", so the merge preserves it and readers treat it as absent.
      try {
        const current = JSON.parse(readFileSync(endpointsFile, 'utf8'));
        const example = JSON.parse(readFileSync(endpointsExample, 'utf8'));
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          const missing = Object.keys(example).filter((key) => !(key in current));
          const currentServers = current.mcpServers;
          const exampleServers = example.mcpServers;
          const missingServers = currentServers && typeof currentServers === 'object' && !Array.isArray(currentServers)
            && exampleServers && typeof exampleServers === 'object' && !Array.isArray(exampleServers)
            ? Object.keys(exampleServers).filter((key) => !(key in currentServers))
            : [];
          if (missing.length > 0) {
            for (const key of missing) current[key] = example[key];
          }
          for (const key of missingServers) currentServers[key] = exampleServers[key];
          if (missing.length > 0 || missingServers.length > 0) {
            writeFileSync(endpointsFile, `${JSON.stringify(current, null, 2)}\n`);
            const changes = [
              missing.length > 0 ? `keys: ${missing.join(', ')}` : '',
              missingServers.length > 0 ? `servers: ${missingServers.join(', ')}` : '',
            ].filter(Boolean).join('; ');
            created.push(`mcp.endpoints.json ${changes}`);
          }
        }
      } catch {
        // Unreadable or invalid JSON: leave the operator's file strictly alone.
      }
    }
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
  } else if (existsSync(envFile)) {
    for (const [key, value] of Object.entries(REQUIRED_ENV_KEYS)) {
      if (writeEnvValueIfMissing(envFile, key, value)) created.push(`.env ${key}=${value}`);
    }
  }
  // Seed once, never rewrite: an existing file is the operator's, whatever it
  // contains. Losing a hand-written proxy block on a package update is exactly
  // the failure mode this scaffold exists to prevent.
  for (const { example, target } of COMPOSE_OVERRIDES) {
    const examplePath = join(packageRoot, example);
    const targetPath = managerComposeOverrideFile(target);
    if (!existsSync(examplePath) || existsSync(targetPath)) continue;
    copyFileSync(examplePath, targetPath);
    created.push(target);
  }
  if (created.length > 0) {
    log(`configuration initialized successfully in ${managerStateDir()} — created ${created.join(' and ')} from packaged defaults. Optional credentials can be added later for external services.`);
  }
  return created;
}

// Mirrors workspacesDir() in core/workspaces.js (which imports this module,
// so it cannot be imported here without a cycle).
function workspacesRootDir() {
  return process.env.WIKI_WORKSPACES_DIR
    ? resolve(process.env.WIKI_WORKSPACES_DIR)
    : join(userManagerDir(), 'workspaces');
}

// Single source of truth for where `.agents-data` lives, shared by the
// manager's own document intake, the per-workspace serve stack, and the
// GLOBAL agents stack (documents/cme containers). All three must resolve the
// same host directory: serve writes an upload into its mount and the
// documents container must find it under the identical path — a divergence
// here is exactly the clean-install "Input file does not exist" bug.
// Canonical location: `<workspaces root>/.agents-data`, session or not.
export function resolveAgentsDataDir(session = null) {
  const configured = process.env.AGENTS_DATA_DIR;
  if (configured) return isAbsolute(configured) ? configured : resolve(managerStateDir(), configured);
  if (session?.workspacePath) return resolve(dirname(session.workspacePath), '.agents-data');
  return resolve(workspacesRootDir(), '.agents-data');
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
