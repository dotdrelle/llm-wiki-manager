import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

export function managerEnvFile() {
  return process.env.WIKI_MANAGER_ENV_FILE
    ? resolve(process.env.WIKI_MANAGER_ENV_FILE)
    : join(managerStateDir(), '.env');
}

export function managerMcpEndpointsFile() {
  return join(managerStateDir(), 'mcp.endpoints.json');
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
