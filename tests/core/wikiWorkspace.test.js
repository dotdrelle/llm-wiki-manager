import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('wiki-workspace autostarts host runtime before workspace services', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /ensure_runtime_up\(\) \{/);
  assert.match(script, /WIKI_MANAGER_RUNTIME_AUTOSTART:-1/);
  assert.match(script, /Starting host agent-runtime/);
  assert.match(script, /start_workspace_services\(\) \{\n  ensure_runtime_up\n(?:[^\n]*\n)*  compose_for_workspace "\$1" up -d --pull never serve mcp-http production-mcp/);
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
  const refresh = await readFile(new URL('../../bin/refresh-project.sh', import.meta.url), 'utf8');

  assert.match(script, /if \[\[ \$# -eq 1 && "\$1" == "refresh" \]\]; then\n    refresh_project/);
  assert.match(script, /source "\$ROOT_DIR\/bin\/refresh-project\.sh"/);
  assert.match(refresh, /refresh_project\(\) \{\n  verify_project_configuration/);
  const refreshBody = refresh.slice(refresh.indexOf('refresh_project() {'), refresh.indexOf('\n}', refresh.indexOf('refresh_project() {')));
  assert.ok(refreshBody.indexOf('verify_project_configuration') < refreshBody.indexOf('runtime_command down'));
  assert.match(refresh, /node "\$ROOT_DIR\/bin\/check-project-config\.js"/);
  assert.match(script, /if ! _agents_dc config >\/dev\/null; then/);
  assert.match(script, /_agents_dc config >\/dev\/null/);
  assert.match(refresh, /compose_for_workspace "\$workspace" config >\/dev\/null/);
  assert.match(refresh, /Configuration changes above take effect when the runtime and agent stacks are started again/);
  assert.match(refresh, /compose_for_workspace "\$workspace" down --rmi all --remove-orphans/);
  assert.match(refresh, /agents_compose purge/);
  assert.doesNotMatch(refresh, /docker (?:image )?prune/);
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
  const source = await readFile(new URL('../../src/core/workspaces.js', import.meta.url), 'utf8');

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

// `reset` deletes everything workspace_reset_keep rejects, and its very next
// statement is `run_wiki … init`, which opens with need_workspace_env. If
// `.env` ever falls out of the keep list, reset erases the workspace and then
// dies before re-scaffolding it — and recovering with `config` mints new ports
// and MCP tokens, invalidating every reference to the old ones. Exercise the
// real function rather than asserting on the source text.
test('workspace_reset_keep protects the workspace registration and method', async () => {
  const { spawnSync } = await import('node:child_process');
  const scriptPath = new URL('../../wiki-workspace', import.meta.url).pathname;
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');
  const start = script.indexOf('workspace_reset_keep() {');
  assert.notEqual(start, -1, 'workspace_reset_keep must exist');
  const body = script.slice(start, script.indexOf('\n}', start) + 2);

  const ask = (name) =>
    spawnSync('bash', ['-c', `${body}\nworkspace_reset_keep "$1"`, '_', name]).status === 0;

  for (const kept of ['.env', '.env.local', '.wikirc.yaml', '.wikirc.yaml.prod', 'templates', 'build-context', '.git']) {
    assert.equal(ask(kept), true, `${kept} must survive a reset`);
  }
  for (const removed of ['wiki', 'deliverables', 'raw', '.wiki', 'CLAUDE.md', '.gitignore', '.environment']) {
    assert.equal(ask(removed), false, `${removed} must be reset`);
  }
});

test('reset re-scaffolds through run_wiki, which requires the workspace env', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  // The coupling the keep list depends on: if either half moves, revisit it.
  assert.match(script, /run_wiki\(\) \{\n  local workspace="\$1"\n  shift\n  need_workspace_env "\$workspace"/);
  assert.match(script, /run_wiki "\$workspace" init/);
  assert.match(script, /workspace_env_file\(\) \{\n  local workspace="\$1"\n  printf '%s\/%s\/\.env\\n'/);
});

// Reset clears CME's delivery list so the next sync re-delivers every page.
// Exercised on the real reset_workspace, sourced with Docker and the runtime
// stubbed: the list goes once the workspace is empty (a failed removal must not leave a full wiki
// whose pages the next sync would deliver again), a failure to clear it is
// announced but not fatal, and an active run refuses the reset.
async function runReset({ activeRuns = '0', failRemoval = false, failInit = false, manifest = true, args = ['--yes'] } = {}) {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const scriptPath = new URL('../../wiki-workspace', import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), 'wiki-workspace-reset-'));
  const ws = join(dir, 'workspaces', 'demo');
  const cme = join(dir, 'workspaces', '.agents-data', 'cme', 'demo');
  await mkdir(join(ws, 'wiki'), { recursive: true });
  await mkdir(join(cme, 'export'), { recursive: true });
  await writeFile(join(ws, '.env'), `WIKI_WORKSPACE_PATH=${ws}\n`);
  await writeFile(join(ws, 'wiki', 'page.md'), '# Page');
  if (manifest) await writeFile(join(cme, 'delivery-manifest.json'), '{}');
  const stubs = [
    'compose_for_workspace() { :; }',
    `runtime_active_runs() { printf '%s' '${activeRuns}'; }`,
    failInit ? 'run_wiki() { return 1; }' : 'run_wiki() { mkdir -p "$WORKSPACES_DIR/$1/wiki"; }',
    failRemoval ? 'rm() { if [[ "$*" == *" -- "*"/wiki" ]]; then return 1; fi; command rm "$@"; }' : '',
  ].join('\n');
  const result = spawnSync('bash', ['-c', `WIKI_WORKSPACE_SOURCE_ONLY=1 source "$0"\n${stubs}\nreset_workspace demo ${args.join(' ')}`, scriptPath], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, AGENTS_DATA_DIR: '', WIKI_WORKSPACES_DIR: join(dir, 'workspaces'), WIKI_MANAGER_ENV_FILE: join(dir, '.env') },
  });
  const { existsSync } = await import('node:fs');
  const state = { status: result.status, output: `${result.stdout}${result.stderr}`, manifest: existsSync(join(cme, 'delivery-manifest.json')), mirror: existsSync(join(cme, 'export')), page: existsSync(join(ws, 'wiki', 'page.md')) };
  await rm(dir, { recursive: true, force: true });
  return state;
}

test('reset clears the CME delivery list last and keeps the export mirror', async () => {
  const done = await runReset();
  assert.equal(done.status, 0, done.output);
  assert.equal(done.page, false);
  assert.equal(done.manifest, false);
  assert.equal(done.mirror, true);
  assert.match(done.output, /CME delivery list cleared/);

  const dry = await runReset({ args: ['--dry-run'] });
  assert.equal(dry.manifest, true);
  assert.match(dry.output, /CME: +.*delivery-manifest\.json \(cleared last/);
});

test('reset keeps the CME list when a removal fails, and says when there is none', async () => {
  const failed = await runReset({ failRemoval: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /could not remove .*\/wiki/);
  assert.equal(failed.manifest, true, 'the list must survive an aborted reset');

  const none = await runReset({ manifest: false });
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /no delivery list in .*cme\/demo — nothing to clear/);
});

test('reset clears the CME list before re-scaffolding, so a failed init cannot keep it', async () => {
  const failed = await runReset({ failInit: true });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.page, false);
  assert.equal(failed.manifest, false, 'an emptied workspace must sync again');
});

test('reset says when the runtime refuses the active-run check', async () => {
  const refused = await runReset({ activeRuns: 'http:401' });
  assert.equal(refused.status, 0, refused.output);
  assert.match(refused.output, /runtime answered 401, so its active runs could not be checked/);
  assert.doesNotMatch(refused.output, /not reachable/);
});

test('reset refuses while the runtime lists a run on the workspace', async () => {
  const busy = await runReset({ activeRuns: '1' });
  assert.notEqual(busy.status, 0);
  assert.match(busy.output, /1 run\(s\) or maintenance cycle\(s\) are active on demo/);
  assert.equal(busy.page, true);
  assert.equal(busy.manifest, true);
});

test('runtime down posts to /shutdown, not to /health/shutdown', async () => {
  // runtime_health_url ends with /health. Appending /shutdown to it hit a 404:
  // the node fetch exited 1, `set -e` ended the script silently and the
  // runtime kept running with its old code.
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /RUNTIME_URL="\$\(runtime_health_url\)\/shutdown"/);
  assert.match(script, /runtime_health_url \| sed 's#\/health\$##'\)\/shutdown/);
});

test('agents up offers the Gmail read tool to chat with the other read-only Gmail tools', async () => {
  // The chat allow-list is explicit; agents up unions it with this list, which
  // is how a tool added to the connectors agent reaches existing installs.
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');
  assert.match(script, /'connectors_gmail_search',\n\s+'connectors_gmail_read',\n\s+'connectors_gmail_labels',/);
});
