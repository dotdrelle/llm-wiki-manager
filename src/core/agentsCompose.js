import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

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

/**
 * Services actually declared in the agents stack, override included.
 *
 * Read from the file rather than hardcoded: a frozen list ended up announcing
 * `mailer`, which only lives in the override example and therefore does not
 * exist until the operator uncomments it. Offering an absent service is
 * promising a "no such service".
 *
 * Used for ROUTING: the agents stack is a Compose project distinct from the
 * workspace's, so `/start <name>` must go to `wiki-workspace agents`.
 */
export function agentServiceNames({ env = resolvedManagerEnv() } = {}) {
  const { composeFiles } = resolveAgentsComposeContext({ env });
  const names = new Set();
  for (const file of composeFiles) {
    try {
      const parsed = YAML.parse(readFileSync(file, 'utf8')) ?? {};
      for (const name of Object.keys(parsed.services ?? {})) names.add(name);
    } catch { /* unreadable file: it declares nothing addressable */ }
  }
  return [...names].sort();
}

/**
 * Agents an operator drives one by one, offered in completions.
 *
 * Only those behind a profile flag: they are the only ones deliberately
 * enabled and disabled. `cme` and `documents` are part of the base — started
 * with `agents`, distinguishing them adds nothing and lengthens a list the
 * operator must read every time.
 */
export function togglableAgentNames() {
  return Object.keys(PROFILE_FLAGS).sort();
}

export function isEnabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/**
 * Why a profiled service is unavailable, and how to enable it.
 *
 * The original message — "the connectors service is unavailable or disabled"
 * — said neither which of the two, nor where to look. Donna, asked next "how
 * do I enable it", had no fact to cite and invented files (`cme.yaml`, an
 * "active services manifest") that exist nowhere. A confident wrong answer
 * costs more than an "I do not know": the message is what must be made
 * sufficient, not the model hoped more cautious.
 *
 * @returns {{ enabled: boolean, flag: string, envFile: string, message: string }}
 */
export function profileServiceStatus(profile, { env = resolvedManagerEnv() } = {}) {
  const flag = PROFILE_FLAGS[profile];
  const envFile = managerEnvFile();
  if (!flag) {
    return {
      enabled: false,
      flag: null,
      envFile,
      message: `There is no "${profile}" service in this deployment.`,
    };
  }
  const enabled = isEnabled(env[flag]);
  if (enabled) {
    return {
      enabled: true,
      flag,
      envFile,
      message: `The ${profile} service is enabled (${flag}) but not reachable — its container is probably not running. Start it with \`/start agents\`.`,
    };
  }
  const current = String(env[flag] ?? '').trim();
  return {
    enabled: false,
    flag,
    envFile,
    message: [
      `The ${profile} service is disabled: ${flag} is ${current === '' ? 'not set' : `"${current}"`} in ${envFile}.`,
      'To enable it:',
      `  1. set ${flag}=true in ${envFile}`,
      '  2. run `/start agents` (or `wiki-workspace agents up`) to start its container',
      `  3. run \`/connector list\` to check it answers`,
      `The ${profile} service runs behind a Compose profile, so while ${flag} is off its container does not exist at all — it will not appear in \`docker compose ps\`.`,
    ].join('\n'),
  };
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
