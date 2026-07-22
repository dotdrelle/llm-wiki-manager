import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { managerEnvFile, managerMcpEndpointsFile, readEnvFile, userManagerDir } from './env.js';

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
    : join(userManagerDir(), 'workspaces');
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
      let resolvedWorkspacePath;
      try {
        resolvedWorkspacePath = realpathSync.native?.(workspacePath) ?? realpathSync(workspacePath);
      } catch {
        // Host-absolute WIKI_WORKSPACE_PATH not accessible here (e.g. inside a container); use registry dir.
        resolvedWorkspacePath = registryPath;
      }
      return [
        {
          name: env.WORKSPACE_NAME || entry.name,
          registryPath,
          envFile,
          workspacePath: resolvedWorkspacePath,
          env,
        },
      ];
    });
}

export function findWorkspace(name) {
  return listWorkspaces().find((workspace) => workspace.name === name);
}

export function isValidWorkspaceName(name) {
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
  const stateDir = dirname(managerEnvFile());
  const { stdout, stderr } = await execFileAsync(
    join(managerRoot(), 'wiki-workspace'),
    args,
    {
      // Relative Compose mounts and default scaffold paths must resolve from
      // the user's manager state, never from the globally installed package.
      cwd: stateDir,
      env: {
        ...process.env,
        WIKI_WORKSPACES_DIR: workspacesDir(),
        WIKI_MANAGER_ENV_FILE: managerEnvFile(),
        // The script runs from the installed package directory so it can find
        // its Compose templates. Pin mutable manager state to the user's
        // launch directory; a global npm package is commonly owned by root
        // and must never become the destination for this scaffold.
        WIKI_MANAGER_ENDPOINTS_FILE: managerMcpEndpointsFile(),
      },
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
      timeout: options.timeout ?? 600_000,
    },
  );
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}
