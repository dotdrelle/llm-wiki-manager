import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

test('runtime startup is not blocked by optional Docker image maintenance', async () => {
  const source = await readFile(new URL('./wiki-manager.js', import.meta.url), 'utf8');
  const runtimeBranch = source.slice(
    source.indexOf("if (argv[0] === 'runtime')"),
    source.indexOf("if (argv.includes('--setup-wizard'))"),
  );

  assert.match(runtimeBranch, /await runRuntime\(argv\.slice\(1\), agent\)/);
  assert.doesNotMatch(runtimeBranch, /refreshRunningContainers/);
});

test('shell exit leaves the shared runtime alive and refresh is explicit', async () => {
  const cli = await readFile(new URL('./wiki-manager.js', import.meta.url), 'utf8');
  const tui = await readFile(new URL('../shell/tui.tsx', import.meta.url), 'utf8');
  const bin = await readFile(new URL('../../bin/wiki-manager.js', import.meta.url), 'utf8');

  assert.doesNotMatch(cli, /await shutdownOwnedRuntime\(runtime/);
  assert.doesNotMatch(tui, /shutdownOwnedRuntime/);
  assert.match(tui, /shell closed; shared runtime left running/);
  assert.match(tui, /process\.exit\(0\)/);
  assert.match(cli, /argv\.includes\('--refresh'\)/);
  assert.match(cli, /spawnSync\(workspaceCliPath, \['refresh'\]/);
  assert.match(bin, /!argv\.includes\('--refresh'\)/);
});
