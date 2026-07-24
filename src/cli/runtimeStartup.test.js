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
