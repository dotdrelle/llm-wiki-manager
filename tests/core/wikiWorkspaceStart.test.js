import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = readFileSync(fileURLToPath(new URL('../../wiki-workspace', import.meta.url)), 'utf8');

test('wiki-workspace start advertises itself in the usage text', () => {
  const usage = script.slice(script.indexOf('Commands:'), script.indexOf('Configuration:'));
  assert.match(usage, /start \[--open\]\s+Start everything: agent-runtime, agents and every/);
  assert.match(usage, /configured workspace/);
});

test('wiki-workspace start routes to a start_all that composes the three idempotent steps', () => {
  const fn = script.slice(script.indexOf("# `start` — the whole deployment"), script.indexOf('ensure_workspace_dirs()'));
  // The whole deployment is the same three commands an operator runs by hand,
  // in the boot order the runtime expects: runtime, agents, then workspaces.
  assert.match(fn, /runtime_command up/);
  assert.match(fn, /agents_compose up/);
  assert.match(fn, /up_workspace "\$name"/);
  // Every configured workspace joins, discovered exactly like list_workspaces:
  // a directory under WORKSPACES_DIR carrying a .env.
  assert.match(fn, /for entry in "\$WORKSPACES_DIR"\/\*/);
  assert.match(fn, /env_value "\$file" WORKSPACE_NAME/);
  // Without workspaces the command still completes, telling the operator how
  // to create one.
  assert.match(fn, /wiki-workspace config <name>/);
  // Repeatable: each step is idempotent, so `start` is safe on a live stack.
  assert.match(fn, /idempotent/);
});

test('the start dispatch accepts only an optional --open', () => {
  const dispatch = script.slice(script.indexOf('# start [--open]'), script.indexOf('# up <workspace> [--open]'));
  assert.match(dispatch, /\[\[ "\$\{2:-\}" == "" \|\| "\$\{2:-\}" == "--open" \]\]/);
  assert.match(dispatch, /start_all "\$start_open"/);
});
