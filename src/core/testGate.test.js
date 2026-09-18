import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The `npm test` argument list is hand-maintained, and it has drifted twice:
// four files were once found outside the gate, and mcpEndpoints.test.js was
// green on disk while nothing ran it. A test nobody runs is worse than no
// test — it reads as coverage. This is the check that says so.
test('every test file on disk is in the npm test gate', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const listed = new Set(
    pkg.scripts.test.split(/\s+/).filter((argument) => argument.endsWith('.test.js')),
  );
  const onDisk = execFileSync('find', ['src', '-name', '*.test.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();

  const missing = onDisk.filter((file) => !listed.has(file));
  assert.deepEqual(missing, [], `test files not run by \`npm test\`:\n${missing.join('\n')}`);

  const stale = [...listed].filter((file) => !onDisk.includes(file));
  assert.deepEqual(stale, [], `\`npm test\` names files that no longer exist:\n${stale.join('\n')}`);
});
