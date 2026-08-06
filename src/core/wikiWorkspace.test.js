import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('wiki-workspace autostarts host runtime before workspace services', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /ensure_runtime_up\(\) \{/);
  assert.match(script, /WIKI_MANAGER_RUNTIME_AUTOSTART:-1/);
  assert.match(script, /Starting host agent-runtime/);
  assert.match(script, /start_workspace_services\(\) \{\n  ensure_runtime_up\n  compose_for_workspace "\$1" up -d serve mcp-http production-mcp/);
  assert.match(script, /start_workspace_services "\$workspace"\n\n  local serve_port prod_port/);
  assert.match(script, /start_workspace_services "\$workspace"\n      local serve_port production_port/);
  assert.match(script, /ensure_runtime_up\n      printf 'Starting mcp-http/);
  assert.match(script, /wait_for_runtime_health\(\) \{/);
  assert.match(script, /if ! wait_for_runtime_health; then/);
  assert.match(script, /runtime_port\(\) \{\n  env_value "\$MANAGER_ENV_FILE" WIKI_MANAGER_RUNTIME_PORT/);
  assert.match(script, /port="\$\(runtime_port\)"/);
  assert.doesNotMatch(script, /sleep 0\.5\n      printf 'agent-runtime started/);
});

test('wiki-workspace checks runtime pid command before killing', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /runtime_pid_command\(\) \{/);
  assert.match(script, /runtime_pid_matches\(\) \{/);
  assert.match(script, /if ! runtime_pid_matches; then\n        printf 'refusing to stop pid/);
  assert.match(script, /kill "\$\(cat "\$pid_file"\)"/);
});

test('project refresh shuts down runtime and removes only compose-owned images', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /if \[\[ \$# -eq 1 && "\$1" == "refresh" \]\]; then\n    refresh_project/);
  assert.match(script, /compose_for_workspace "\$workspace" down --rmi all --remove-orphans/);
  assert.match(script, /_agents_dc down --rmi all --remove-orphans/);
  assert.doesNotMatch(script, /docker (?:image )?prune/);
});

test('wiki-workspace regenerates CA compose overrides instead of retaining removed services', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.doesNotMatch(script, /if \[\[ ! -f "\$override_path" \]\]; then/);
  assert.match(script, /local tmp_override="\$override_path\.tmp\.\$\$"/);
  assert.match(script, /mv "\$tmp_override" "\$override_path"/);
  assert.match(script, /Changes are overwritten on the next compose command/);
});

test('wiki-workspace provisions connector secrets and persistent state', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /connectors_enabled\(\) \{/);
  assert.match(script, /CONNECTORS_ENABLED/);
  assert.doesNotMatch(script, /\$\{enabled,,\}/);
  assert.match(script, /\[Tt\]\[Rr\]\[Uu\]\[Ee\]/);
  assert.match(script, /profile_args\+=\(--profile connectors\)/);
  assert.match(script, /COMPOSE_PROFILES= \\\n      docker compose/);
  assert.match(script, /if connectors_enabled; then/);
  assert.match(script, /CONNECTORS_MCP_AUTH_TOKEN OAUTH_STATE_SECRET OAUTH_START_TOKEN/);
  assert.match(script, /http:\/\/127\.0\.0\.1:\$\{connectors_port\}\/oauth\/google\/callback/);
  assert.match(script, /set_env_value "\$MANAGER_ENV_FILE" GOOGLE_OAUTH_CALLBACK_URL/);
  assert.match(script, /"\$agents_data_dir\/connectors"/);
  assert.match(script, /config\.mcpServers\.connectors \?\?=/);
  assert.match(script, /config\.chatAccess\.servers\.connectors \?\?=/);
  assert.match(script, /delete config\.mcpServers\.connectors/);
  assert.match(script, /delete config\.chatAccess\.servers\.connectors/);
});

test('the manager never builds an image, it only runs published ones', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  // Ce script est livré dans le paquet npm, où le dépôt agent-connectors
  // n'existe pas : il ne peut ni construire l'image, ni lire le
  // .env.build.local qui porte l'application OAuth. La construction appartient
  // à build-and-push.sh. Pour utiliser sa propre application Google,
  // l'opérateur surcharge GOOGLE_OAUTH_CLIENT_ID / _SECRET dans le .env.
  assert.doesNotMatch(script, /--build\b/);
  assert.doesNotMatch(script, /\.env\.build\.local/);
  assert.doesNotMatch(script, /require_connectors_build_credentials/);
});

test('workspace creation keeps mutable manager files outside the installed package', async () => {
  const source = await readFile(new URL('./workspaces.js', import.meta.url), 'utf8');

  assert.match(source, /const stateDir = dirname\(managerEnvFile\(\)\)/);
  assert.match(source, /cwd: stateDir/);
  assert.match(source, /WIKI_MANAGER_ENV_FILE: managerEnvFile\(\)/);
  assert.match(source, /WIKI_MANAGER_ENDPOINTS_FILE: managerMcpEndpointsFile\(\)/);
});

test('wiki-workspace rejects an MCP endpoints directory instead of copying into it', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /\[\[ -e "\$MANAGER_ENDPOINTS_FILE" && ! -f "\$MANAGER_ENDPOINTS_FILE" \]\]/);
  assert.match(script, /MCP endpoints path is not a file/);
});

test('container refresh pulls and renews only services that are already running', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /refresh_running_services\(\) \{/);
  assert.match(script, /\[\[ -n "\$\{line\/\/\[\[:space:\]\]\/\}" \]\] \|\| continue/);
  assert.match(script, /ps --status running --services/);
  assert.match(script, /"\$@" pull "\$\{running_services\[@\]\}"/);
  assert.match(script, /refresh_running_services 'No running external agent containers to refresh' 'Refreshed running agents: %s' _agents_dc/);
  assert.match(script, /refresh_running_services "No running workspace containers to refresh: \$workspace" "Refreshed running workspace containers: \$workspace \(%s\)" compose_for_workspace "\$workspace"/);
});

// `${arr[@]}` on an empty array is an unbound-variable error under `set -u` in
// bash <= 4.3, and macOS still ships /bin/bash 3.2. `parse_global_options`
// tripped on it, so `wiki-workspace` with no global option died before reaching
// any subcommand.
//
// The execution check below cannot catch a regression on a CI running bash 5,
// where an empty array is legal — hence the source assertion that every
// optional array keeps the `${arr[@]+"${arr[@]}"}` guard. Both are needed.
test('optional arrays keep the empty-array guard required by bash 3.2', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  for (const name of ['parsed', 'PARSED_ARGS', 'log_args']) {
    const unguarded = new RegExp(String.raw`(?<!\+)"\$\{${name}\[@\]\}"`);
    assert.doesNotMatch(script, unguarded, `${name}[@] must use the \${name[@]+"..."} guard`);
  }
  assert.match(script, /set -- \$\{parsed\[@\]\+"\$\{parsed\[@\]\}"\}/);
  assert.match(script, /set -- \$\{PARSED_ARGS\[@\]\+"\$\{PARSED_ARGS\[@\]\}"\}/);
});

test('wiki-workspace reaches its usage text with no arguments', async () => {
  const { spawnSync } = await import('node:child_process');
  const scriptPath = new URL('../../wiki-workspace', import.meta.url).pathname;

  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });

  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unbound variable/);
  assert.match(result.stdout, /^Usage:/);
  assert.equal(result.status, 2);
});
