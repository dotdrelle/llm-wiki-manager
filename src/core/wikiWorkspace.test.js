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
});
