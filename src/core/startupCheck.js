import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseComposePsJson } from './compose.js';
import { listWikircProfiles, loadWikircProfile, summarizeWikircConfig } from './wikirc.js';
import { listWorkspaces, managerRoot, workspacesDir } from './workspaces.js';

const execFileAsync = promisify(execFile);

async function checkAgents() {
  const composeFile = join(managerRoot(), 'agents.docker-compose.yml');
  if (!existsSync(composeFile)) return null;
  try {
    const { stdout } = await execFileAsync('docker', [
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

export async function runChecks() {
  const workspaces = listWorkspaces();
  const agents = await checkAgents();
  const gaps = [];
  if (agents) gaps.push(agents);
  const workspaceGap = checkWorkspace(workspaces);
  if (workspaceGap) {
    gaps.push(workspaceGap);
    return gaps;
  }
  gaps.push(...checkWikirc(workspaces[0] ?? null));
  return gaps;
}
