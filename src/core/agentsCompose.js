import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { managerComposeOverrideFile, managerEnvFile, readEnvFile } from './env.js';
import { managerRoot } from './workspaces.js';

export const AGENTS_COMPOSE_PROJECT = 'wiki-agents';
export const AGENTS_COMPOSE_FILE = 'agents.docker-compose.yml';
export const AGENTS_COMPOSE_OVERRIDE = 'agents.docker-compose.override.yml';

// Services behind a compose profile, and the manager flag that activates each.
// A profiled service is invisible to every compose command — `ps` included —
// unless its profile is active, which is why an inactive profile used to look
// exactly like "the flag was ignored".
export const PROFILE_FLAGS = Object.freeze({
  connectors: 'CONNECTORS_ENABLED',
});

export function isEnabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/**
 * The manager `.env` wins over the ambient process environment.
 *
 * Compose normally gives an already-exported process variable precedence over
 * `--env-file`. The manager deliberately defines the opposite policy for its
 * owned configuration, then passes this resolved environment explicitly to
 * `wiki-workspace`, so stale values loaded at boot cannot shadow a later .env
 * update.
 */
export function resolvedManagerEnv() {
  let fileEnv = {};
  try {
    fileEnv = readEnvFile(managerEnvFile());
  } catch {
    // No manager .env yet: valid during first-run setup.
  }
  return { ...process.env, ...fileEnv };
}

/**
 * Single source of truth for how the agents stack is addressed: the compose
 * files, the user-owned override, the active profiles and the project name.
 * `checkAgents`, the image detection and the post-start verification all go
 * through this, so they can never observe a different set of services than the
 * one `wiki-workspace agents up` actually started.
 */
export function resolveAgentsComposeContext({ env = resolvedManagerEnv() } = {}) {
  const composeFile = join(managerRoot(), AGENTS_COMPOSE_FILE);
  const envFile = managerEnvFile();
  const overrideFile = managerComposeOverrideFile(AGENTS_COMPOSE_OVERRIDE);
  const profiles = Object.entries(PROFILE_FLAGS)
    .filter(([, flag]) => isEnabled(env[flag]))
    .map(([profile]) => profile)
    .sort();

  const composeFiles = [composeFile, ...(existsSync(overrideFile) ? [overrideFile] : [])];
  const args = ['compose', '--project-directory', managerRoot()];
  if (existsSync(envFile)) args.push('--env-file', envFile);
  for (const file of composeFiles) args.push('-f', file);
  for (const profile of profiles) args.push('--profile', profile);
  args.push('-p', AGENTS_COMPOSE_PROJECT);

  return {
    args,
    profiles,
    env,
    composeFile,
    composeFiles,
    envFile,
    overrideFile,
    exists: existsSync(composeFile),
    // Services the operator asked for that a `ps` MUST therefore report as
    // running — an enabled profile whose container is absent is a failure, not
    // an opt-out.
    expectedProfileServices: profiles,
  };
}
