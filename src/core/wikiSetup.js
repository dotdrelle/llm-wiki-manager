import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { checkMissingDockerImages } from './dockerImages.js';
import { loadWikircProfile, patchWikircProfile } from './wikirc.js';
import { buildInheritedWikircPatch } from './workspaceInherit.js';
import { resolveAgentsComposeContext } from './agentsCompose.js';
import { managerEnvFile, managerMcpEndpointsFile, resolveAgentsDataDir } from './env.js';
import { createWorkspace, findWorkspace, isValidWorkspaceName, listWorkspaces, managerRoot, workspacesDir } from './workspaces.js';

const execFileAsync = promisify(execFile);

export function configuredAgentImages(config, activeProfiles = new Set()) {
  return Object.values(config.services ?? {})
    .filter((service) => {
      const profiles = Array.isArray(service?.profiles) ? service.profiles : [];
      return profiles.length === 0 || profiles.some((profile) => activeProfiles.has(profile));
    })
    .map((service) => service?.image)
    .filter(Boolean);
}

async function missingAgentImages(context = resolveAgentsComposeContext()) {
  // Same resolution as the preflight and as `wiki-workspace agents up`: an
  // image behind a profile the operator did not enable must not be reported
  // missing, and one behind a profile they DID enable must be.
  const activeProfiles = new Set(context.profiles);
  const composeFiles = context.composeFiles.filter(existsSync);
  const images = [...new Set(composeFiles.flatMap((filePath) => {
    try {
      const config = YAML.parse(readFileSync(filePath, 'utf8')) ?? {};
      return configuredAgentImages(config, activeProfiles);
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
  const composeContext = options.composeContext ?? resolveAgentsComposeContext();
  try {
    const absentImages = options.imagesCheck
      ? await options.imagesCheck(composeContext)
      : await missingAgentImages(composeContext);
    if (absentImages.length > 0) options.onImagesMissing?.(absentImages);
    const exec = options.exec ?? execFileAsync;
    const { stdout, stderr } = await exec(join(managerRoot(), 'wiki-workspace'), ['agents', 'up', ...(options.services ?? [])], {
      cwd: managerRoot(),
      env: {
        ...process.env,
        // Compose gives variables already exported by its parent process
        // precedence over --env-file, including an empty value loaded at boot.
        // Re-apply the manager's resolved policy here so a token/secret written
        // later to .env is not shadowed by stale process.env state.
        ...composeContext.env,
        WIKI_WORKSPACES_DIR: workspacesDir(),
        // cwd is the npm package root (the script and compose files live
        // there), so the manager files MUST be pinned explicitly: without
        // these, wiki-workspace resolved .env and mcp.endpoints.json against
        // $PWD and generated agent tokens into the PACKAGE directory — the
        // user's .env stayed empty on a fresh install.
        WIKI_MANAGER_ENV_FILE: managerEnvFile(),
        WIKI_MANAGER_ENDPOINTS_FILE: managerMcpEndpointsFile(),
        // Same pinning for .agents-data: without it the script defaults to
        // $PWD/.agents-data (the PACKAGE directory), while the serve stack
        // mounts the workspace-root .agents-data — the documents container
        // then reads an empty input dir and every conversion fails with
        // "Input file does not exist" on a clean install.
        AGENTS_DATA_DIR: resolveAgentsDataDir(),
      },
      timeout: options.timeout ?? 180_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
    });
    // `wiki-workspace agents up` also (re)writes mcp.endpoints.json, so the
    // endpoints must be re-read here — the caller's in-memory session still
    // holds the file as it was BEFORE the connectors entry was added, and the
    // freshly started agent would stay unreachable until the next restart.
    const verification = await verifyAgentsStarted({
      context: composeContext,
      agentsCheck: options.agentsCheck,
    });
    if (!verification.ok) throw agentsStartFailure(verification);
    return {
      output: [stdout, stderr].filter(Boolean).join('\n').trim(),
      missingImages: absentImages,
      profiles: composeContext.profiles,
    };
  } catch (err) {
    // One optional agent failing to start (today: the agentic gateway, whose
    // image is not pulled yet) makes `docker compose up` exit non-zero — but
    // the base stack usually DID come up. Aborting here turned `/start all`
    // into "gateway image missing ⇒ workspace never starts", which is the
    // optional tail wagging the whole dog. If the base agents are up, degrade
    // loudly instead of failing: the caller continues, and the absent agent
    // announces itself through its own check (/status, preflight, discovery).
    const verification = await verifyAgentsStarted({
      context: composeContext,
      agentsCheck: options.agentsCheck,
    }).catch(() => null);
    if (verification?.ok) {
      return {
        output: [
          (options.services ?? []).length > 0
            ? 'A requested agent failed to start — the rest of the stack is up.'
            : 'The agents stack started degraded — one optional agent failed (see /status).',
          err instanceof Error ? (err.message ?? String(err)) : String(err),
        ].filter(Boolean).join('\n').trim(),
        missingImages: [],
        profiles: composeContext.profiles,
        degraded: true,
        degradedError: wrapDockerError(err),
      };
    }
    throw wrapDockerError(err);
  }
}

// A start that leaves an enabled service down is a failure. Reporting success
// and letting the operator discover it through a silent preflight line is what
// made CONNECTORS_ENABLED=true look like it had been ignored.
async function verifyAgentsStarted({ context, agentsCheck }) {
  const check = agentsCheck ?? (await import('./startupCheck.js')).checkAgents;
  const gap = await check({ context });
  if (!gap) return { ok: true, profiles: context.profiles };
  const down = gap.context?.downServices ?? [];
  const missing = gap.context?.missingServices ?? [];
  if (down.length === 0 && missing.length === 0) return { ok: true, profiles: context.profiles };
  return { ok: false, downServices: down, missingServices: missing, profiles: context.profiles };
}

function agentsStartFailure({ downServices = [], missingServices = [], profiles = [] }) {
  const parts = [
    missingServices.length > 0 ? `never started: ${missingServices.join(', ')}` : '',
    downServices.length > 0 ? `not running: ${downServices.join(', ')}` : '',
  ].filter(Boolean);
  const error = new Error(
    `Agents started, but the expected services are not up (${parts.join('; ')}).`
    + (profiles.length > 0 ? ` Active profiles: ${profiles.join(', ')}.` : ''),
  );
  error.name = 'AgentsNotRunningError';
  error.downServices = downServices;
  error.missingServices = missingServices;
  return error;
}

export async function stopAgents(options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(join(managerRoot(), 'wiki-workspace'), ['agents', 'down', ...(options.services ?? [])], {
      cwd: managerRoot(),
      env: {
        ...process.env,
        WIKI_WORKSPACES_DIR: workspacesDir(),
        // Même épinglage que startAgents, et pour la même raison : cwd est la
        // racine du paquet, donc sans ces variables le script résout `.env`
        // contre $PWD. `connectors_enabled` lisait alors le .env du PAQUET,
        // concluait que le profil était inactif, et `docker compose down`
        // partait sans `--profile connectors` — un service à profil inactif est
        // invisible à Compose, donc le conteneur restait debout. `/stop agents`
        // annonçait un succès en laissant tourner ce qu'il prétendait arrêter.
        WIKI_MANAGER_ENV_FILE: managerEnvFile(),
        WIKI_MANAGER_ENDPOINTS_FILE: managerMcpEndpointsFile(),
        AGENTS_DATA_DIR: resolveAgentsDataDir(),
      },
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
    });
    return [stdout, stderr].filter(Boolean).join('\n').trim();
  } catch (err) {
    throw wrapDockerError(err);
  }
}

export async function refreshRunningContainers(options = {}) {
  if (process.env.WIKI_MANAGER_AUTO_UPDATE === '0') {
    return { skipped: true, refreshed: [] };
  }
  const script = join(managerRoot(), 'wiki-workspace');
  const common = {
    cwd: dirname(managerEnvFile()),
    env: {
      ...process.env,
      WIKI_WORKSPACES_DIR: workspacesDir(),
      WIKI_MANAGER_ENV_FILE: managerEnvFile(),
      WIKI_MANAGER_ENDPOINTS_FILE: managerMcpEndpointsFile(),
      AGENTS_DATA_DIR: resolveAgentsDataDir(),
    },
    timeout: options.timeout ?? 600_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
  };
  const targets = [['agents', 'refresh'], ...listWorkspaces().map((workspace) => ['wiki', workspace.name, 'refresh'])];
  // Each target is an independent Compose project (its own agents/workspace
  // stack) — refresh them concurrently instead of summing every target's
  // pull/restart time into one sequential wait.
  const results = await Promise.all(targets.map(async (args) => {
    options.onStep?.(`Images: checking ${args[0] === 'agents' ? 'running agents' : `workspace ${args[1]}`}…`);
    try {
      const { stdout, stderr } = await execFileAsync(script, args, common);
      return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
    } catch (err) {
      return { ok: false, error: wrapDockerError(err).message };
    }
  }));
  const refreshed = results.filter((result) => result.ok).map((result) => result.output).filter(Boolean);
  const errors = results.filter((result) => !result.ok).map((result) => result.error);
  return { skipped: false, refreshed, errors };
}

export async function createNewWorkspace(name, targetPath, options = {}) {
  try {
    const output = await createWorkspace(name, targetPath, { timeout: 600_000 });
    const { workspace, inherited } = await finalizeCreatedWorkspace(name, options);
    return { output, workspace, inherited };
  } catch (err) {
    throw wrapDockerError(err);
  }
}

/**
 * @param options.inheritFrom name of the workspace to copy LLM config from —
 *   normally the session's current workspace. Omitted, or unknown, means
 *   "scaffold defaults only", the previous behaviour. Confluence credentials
 *   are NOT inherited: agent-cme stores them agent-wide (shared across all
 *   workspaces), so a new workspace already sees them.
 */
export async function finalizeCreatedWorkspace(name, options = {}) {
  const workspace = findWorkspace(name);
  if (!workspace) return { workspace: null, inherited: [] };
  // Order matters: the access key is this workspace's own credential and must
  // land before anything else touches the file.
  initializeWorkspaceWikirc(workspace);
  const inherited = await inheritWorkspaceSetup(workspace, options.inheritFrom ?? null);
  return { workspace, inherited };
}

/**
 * Carry an existing workspace's proven setup over to a new one. Best effort by
 * design: a workspace that exists and works must never fail to be created
 * because the workspace next door has an unreadable config.
 */
export async function inheritWorkspaceSetup(workspace, sourceName) {
  if (!workspace?.workspacePath || !sourceName || sourceName === workspace.name) return [];
  const source = findWorkspace(sourceName);
  if (!source?.workspacePath) return [];

  const inherited = [];
  try {
    const { config: sourceConfig } = loadWikircProfile(source.workspacePath, 'default');
    const { config: targetConfig } = loadWikircProfile(workspace.workspacePath, 'default');
    const { patch, inherited: keys } = buildInheritedWikircPatch(sourceConfig, targetConfig);
    if (keys.length > 0) {
      patchWikircProfile(workspace.workspacePath, 'default', patch);
      inherited.push(...keys);
    }
  } catch {
    // Unreadable or absent profile on either side — nothing to inherit.
  }

  return inherited;
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

/**
 * Le wizard tourne sur l'hôte, les services dans Docker : une baseUrl saisie
 * en `localhost` répond au wizard et échoue dans le container. On la réécrit
 * vers `host.docker.internal`, que les services déclarent déjà en
 * `extra_hosts`. Jamais sur un hostname réel — seulement sur les trois formes
 * de boucle locale. L'appelant affiche la réécriture : la faire en silence
 * rend le diagnostic impossible quand elle se trompe.
 */
export function containerReachableUrl(baseUrl) {
  if (!baseUrl) return { url: baseUrl, rewritten: false };
  try {
    const parsed = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
      return { url: baseUrl, rewritten: false };
    }
    const original = parsed.hostname;
    parsed.hostname = 'host.docker.internal';
    return { url: parsed.toString().replace(/\/$/, ''), rewritten: true, from: original };
  } catch {
    return { url: baseUrl, rewritten: false };
  }
}

export function writeLlmConfig(workspacePath, profileName, config) {
  const patches = {
    llm: {
      provider: config.provider,
      // Absent derrière une gateway : l'endpoint est opaque, il n'y a pas un
      // moteur mais un par modèle.
      ...(config.engine ? { engine: config.engine } : {}),
      ...(config.baseUrl ? { baseUrl: containerReachableUrl(config.baseUrl).url } : {}),
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
        // baseUrl et apiKey absents = hérités du bloc llm par resolveConfig.
        // Le wizard ne les transmet que lorsqu'ils divergent réellement, pour
        // que le wikirc reste lisible et que la clé du LLM ne soit pas
        // recopiée vers un autre hôte.
        ...(config.baseUrl ? { baseUrl: containerReachableUrl(config.baseUrl).url } : {}),
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
