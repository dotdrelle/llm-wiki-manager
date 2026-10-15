import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = readFileSync(fileURLToPath(new URL('../../wiki-workspace', import.meta.url)), 'utf8');

test('wiki-workspace start advertises itself in the usage text', () => {
  const usage = script.slice(script.indexOf('Commands:'), script.indexOf('Configuration:'));
  assert.match(usage, /start \[--pull\] \[--open\]\s+Start everything with local images/);
  assert.match(usage, /configured workspace/);
});

test('wiki-workspace start starts providers before the runtime and workspaces', () => {
  const fn = script.slice(script.indexOf("# `start` — optionally refresh published images"), script.indexOf('ensure_workspace_dirs()'));
  const workspaceStart = script.slice(script.indexOf('up_workspace() {'), script.indexOf('\nmain() {'));
  // The whole deployment is the same three commands an operator runs by hand,
  // in dependency order: agents and gateway, runtime, then workspaces.
  assert.match(fn, /runtime_command up/);
  assert.match(fn, /if \[\[ "\$pull_images" == "1" \]\]; then\n    agents_compose up --pull/);
  assert.ok(fn.indexOf('agents_compose up') < fn.indexOf('runtime_command up'));
  assert.match(script, /local up_args=\(up -d --pull never\)/, 'agent compose up must never re-pull latest images');
  assert.match(script, /compose_for_workspace "\$1" up -d --pull never serve mcp-http production-mcp/, 'workspace compose up must use cached images');
  assert.match(fn, /up_workspace "\$name" 0 "\$pull_images"/);
  assert.match(workspaceStart, /compose_for_workspace "\$workspace" pull serve mcp-http production-mcp/);
  // Every configured workspace joins, discovered exactly like list_workspaces:
  // a directory under WORKSPACES_DIR carrying a .env.
  assert.match(fn, /for entry in "\$WORKSPACES_DIR"\/\*/);
  assert.match(fn, /env_value "\$file" WORKSPACE_NAME/);
  // Without workspaces the command still completes, telling the operator how
  // to create one.
  assert.match(fn, /wiki-workspace config <name>/);
  // Repeatable: each step remains safe to invoke on a live stack.
  assert.match(fn, /safe to repeat/);
});

test('the start dispatch accepts pull controls and --open in either order', () => {
  const dispatch = script.slice(script.indexOf('# start [--pull] [--open]'), script.indexOf('# up <workspace> [--open]'));
  assert.match(dispatch, /for option in "\$@"/);
  assert.match(dispatch, /--open\) start_open=1/);
  assert.match(dispatch, /--pull\) start_pull=1/);
  assert.match(dispatch, /local start_pull=0/);
  assert.match(dispatch, /start_all "\$start_open" "\$start_pull"/);
});
