import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readEnvFile } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../..');
const execFileAsync = promisify(execFile);

export function managerRoot() {
  return process.env.WIKI_MANAGER_ROOT
    ? resolve(process.env.WIKI_MANAGER_ROOT)
    : packageRoot;
}

export function workspacesDir() {
  return process.env.WIKI_WORKSPACES_DIR
    ? resolve(process.env.WIKI_WORKSPACES_DIR)
    : join(managerRoot(), 'workspaces');
}

export function listWorkspaces() {
  const root = workspacesDir();
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .flatMap((entry) => {
      const registryPath = join(root, entry.name);
      const envFile = join(registryPath, '.env');
      if (!existsSync(envFile)) return [];
      const env = readEnvFile(envFile);
      const workspacePath = env.WIKI_WORKSPACE_PATH || registryPath;
      return [
        {
          name: env.WORKSPACE_NAME || entry.name,
          registryPath,
          envFile,
          workspacePath: realpathSync.native?.(workspacePath) ?? realpathSync(workspacePath),
          env,
        },
      ];
    });
}

export function findWorkspace(name) {
  return listWorkspaces().find((workspace) => workspace.name === name);
}

function isValidWorkspaceName(name) {
  return (
    typeof name === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(name) &&
    !name.includes('..')
  );
}

export async function createWorkspace(name, targetPath = null, options = {}) {
  if (!isValidWorkspaceName(name)) {
    throw new Error('Usage: /workspace init <name> [path]');
  }
  const args = ['config', name];
  if (targetPath) args.push(targetPath);
  const { stdout, stderr } = await execFileAsync(
    join(managerRoot(), 'wiki-workspace'),
    args,
    {
      cwd: managerRoot(),
      env: {
        ...process.env,
        WIKI_WORKSPACES_DIR: workspacesDir(),
      },
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
      timeout: options.timeout ?? 600_000,
    },
  );
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}
