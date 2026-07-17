import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { checkMissingDockerImages } from './dockerImages.js';
import { patchWikircProfile } from './wikirc.js';
import { managerEnvFile, managerMcpEndpointsFile } from './env.js';
import { createWorkspace, findWorkspace, isValidWorkspaceName, listWorkspaces, managerRoot, workspacesDir } from './workspaces.js';

const execFileAsync = promisify(execFile);

async function missingAgentImages() {
  const composeFiles = [
    join(managerRoot(), 'agents.docker-compose.yml'),
    join(dirname(managerEnvFile()), 'agents.docker-compose.override.yml'),
  ].filter(existsSync);
  const images = [...new Set(composeFiles.flatMap((filePath) => {
    try {
      const config = YAML.parse(readFileSync(filePath, 'utf8')) ?? {};
      return Object.values(config.services ?? {}).map((service) => service?.image).filter(Boolean);
    } catch {
      return [];
    }
  }))];
  return checkMissingDockerImages(images);
}

function wrapDockerError(err) {
  if (err?.code === 'ENOENT') {
    return new Error('wiki-workspace script not found. Reinstall wiki-manager.');
  }
  const message = String(err?.message ?? '');
  const output = [err?.stderr, err?.stdout, message].filter(Boolean).map(String).join('\n');
  if (output.includes('docker: command not found') || output.includes('docker: not found')) {
    return new Error('Docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/) and restart.');
  }
  if (output.includes('Cannot connect to the Docker daemon') || output.includes('Is the docker daemon running')) {
    return new Error('Docker daemon is not running. Start Docker Desktop and try again.');
  }
  const commandMatch = message.match(/^Command failed:\s+(.+)$/m);
  if (commandMatch) {
    const [, commandLine] = commandMatch;
    const rest = message.split(/\r?\n/).slice(1).join('\n').trim();
    return new Error([
      'Command failed:',
      commandLine,
      rest,
    ].filter(Boolean).join('\n'));
  }
  return err;
}

export async function startAgents(options = {}) {
  try {
    const absentImages = await missingAgentImages();
    if (absentImages.length > 0) options.onImagesMissing?.(absentImages);
    const { stdout, stderr } = await execFileAsync(join(managerRoot(), 'wiki-workspace'), ['agents', 'up'], {
      cwd: managerRoot(),
      env: {
        ...process.env,
        WIKI_WORKSPACES_DIR: workspacesDir(),
        // cwd is the npm package root (the script and compose files live
        // there), so the manager files MUST be pinned explicitly: without
        // these, wiki-workspace resolved .env and mcp.endpoints.json against
        // $PWD and generated agent tokens into the PACKAGE directory — the
        // user's .env stayed empty on a fresh install.
        WIKI_MANAGER_ENV_FILE: managerEnvFile(),
        WIKI_MANAGER_ENDPOINTS_FILE: managerMcpEndpointsFile(),
      },
      timeout: options.timeout ?? 180_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
    });
    return {
      output: [stdout, stderr].filter(Boolean).join('\n').trim(),
      missingImages: absentImages,
    };
  } catch (err) {
    throw wrapDockerError(err);
  }
}

export async function stopAgents(options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(join(managerRoot(), 'wiki-workspace'), ['agents', 'down'], {
      cwd: managerRoot(),
      env: {
        ...process.env,
        WIKI_WORKSPACES_DIR: workspacesDir(),
      },
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
    });
    return [stdout, stderr].filter(Boolean).join('\n').trim();
  } catch (err) {
    throw wrapDockerError(err);
  }
}

export async function createNewWorkspace(name, targetPath) {
  try {
    const output = await createWorkspace(name, targetPath, { timeout: 600_000 });
    const workspace = finalizeCreatedWorkspace(name);
    return { output, workspace };
  } catch (err) {
    throw wrapDockerError(err);
  }
}

export function finalizeCreatedWorkspace(name) {
  const workspace = findWorkspace(name);
  if (workspace) initializeWorkspaceWikirc(workspace);
  return workspace;
}

export function initializeWorkspaceWikirc(workspace) {
  const accessKey = workspace?.env?.WIKI_MCP_AUTH_TOKEN;
  if (!workspace?.workspacePath || !accessKey) return null;
  return patchWikircProfile(workspace.workspacePath, 'default', {
    mcp: {
      accessKey,
    },
  });
}

export async function unregisterWorkspace(nameOrWorkspace) {
  const workspace = typeof nameOrWorkspace === 'string' ? findWorkspace(nameOrWorkspace) : nameOrWorkspace;
  if (!workspace) throw new Error(`Workspace not found: ${nameOrWorkspace}`);
  await rm(workspace.registryPath, { recursive: true, force: true });
  return workspace;
}

export async function renameWorkspace(name, nextName) {
  if (!isValidWorkspaceName(nextName)) throw new Error('Invalid workspace name.');
  const all = listWorkspaces();
  const workspace = all.find((w) => w.name === name);
  if (!workspace) throw new Error(`Workspace not found: ${name}`);
  if (all.find((w) => w.name === nextName)) throw new Error(`Workspace already exists: ${nextName}`);
  const nextRegistryPath = join(workspacesDir(), nextName);
  const envText = await readFile(workspace.envFile, 'utf8');
  const nextEnvText = envText.match(/^WORKSPACE_NAME=/m)
    ? envText.replace(/^WORKSPACE_NAME=.*$/m, `WORKSPACE_NAME=${nextName}`)
    : `${envText.trimEnd()}\nWORKSPACE_NAME=${nextName}\n`;
  const tmpEnvFile = join(workspace.registryPath, `.env.${process.pid}.tmp`);
  await writeFile(tmpEnvFile, nextEnvText, 'utf8');
  await rename(tmpEnvFile, workspace.envFile);
  await rename(workspace.registryPath, nextRegistryPath);
  return { previousName: name, name: nextName, registryPath: nextRegistryPath };
}

export async function deleteWorkspaceAndFiles(name, workspacePath) {
  const workspace = await unregisterWorkspace(name);
  const target = workspacePath || workspace.workspacePath;
  await rm(target, { recursive: true, force: true });
  return { workspace, deletedPath: target };
}

export function writeLanguageConfig(workspacePath, profileName, language) {
  return patchWikircProfile(workspacePath, profileName || 'default', { language });
}

export function writeLlmConfig(workspacePath, profileName, config) {
  const patches = {
    llm: {
      provider: config.provider,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      model: config.model,
    },
  };
  return patchWikircProfile(workspacePath, profileName || 'default', patches);
}

export function writeVectorConfig(workspacePath, profileName, config) {
  const patches = {
    retrieval: {
      vector: {
        enabled: true,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        timeoutMs: config.timeoutMs ?? 600_000,
        embeddingModel: config.embeddingModel,
        rerankEnabled: Boolean(config.rerankEnabled),
        ...(config.rerankerModel ? { rerankerModel: config.rerankerModel } : {}),
        topK: config.topK ?? 120,
        rerankTopK: config.rerankTopK ?? 80,
        maxResults: config.maxResults ?? 6,
      },
    },
  };
  return patchWikircProfile(workspacePath, profileName || 'default', patches);
}
