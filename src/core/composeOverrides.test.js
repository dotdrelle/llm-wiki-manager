import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { COMPOSE_OVERRIDES, ensureManagerScaffold, managerComposeOverrideFile } from './env.js';

function withStateDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-manager-overrides-'));
  const previous = process.env.WIKI_MANAGER_ENV_FILE;
  process.env.WIKI_MANAGER_ENV_FILE = join(root, '.env');
  try {
    return run(root);
  } finally {
    if (previous === undefined) delete process.env.WIKI_MANAGER_ENV_FILE;
    else process.env.WIKI_MANAGER_ENV_FILE = previous;
  }
}

test('packaged override templates are valid compose files with an empty services map', async () => {
  for (const { example } of COMPOSE_OVERRIDES) {
    const raw = await readFile(new URL(`../../${example}`, import.meta.url), 'utf8');
    const parsed = YAML.parse(raw);
    assert.deepEqual(parsed?.services, {}, `${example} must parse to an empty services map`);
    // A named service here would be merged into every deployment and become a
    // phantom service as soon as the packaged file drops it.
    assert.equal(Object.keys(parsed).length, 1, `${example} must declare nothing but services`);
  }
});

test('scaffold seeds both compose overrides once and never rewrites them', () => {
  withStateDir(() => {
    const created = ensureManagerScaffold();
    for (const { target } of COMPOSE_OVERRIDES) {
      assert.ok(created.includes(target), `expected ${target} to be created`);
    }

    const edited = '# operator edit\nservices:\n  serve:\n    environment:\n      - HTTP_PROXY=http://proxy:3128\n';
    const workspaceOverride = managerComposeOverrideFile('docker-compose.override.yml');
    writeFileSync(workspaceOverride, edited, 'utf8');

    const second = ensureManagerScaffold();
    assert.equal(readFileSync(workspaceOverride, 'utf8'), edited, 'operator edits must survive re-scaffolding');
    for (const { target } of COMPOSE_OVERRIDES) {
      assert.ok(!second.includes(target), `${target} must not be recreated`);
    }
  });
});

test('the Node compose path merges the user override before the generated CA override', async () => {
  const source = await readFile(new URL('./compose.js', import.meta.url), 'utf8');
  const userOverrideIndex = source.indexOf("args.push('-f', userOverride)");
  const cacertIndex = source.indexOf("args.push('-f', cacertOverride)");
  assert.ok(userOverrideIndex > 0, 'composeBaseArgs must include the user override');
  assert.ok(cacertIndex > userOverrideIndex, 'the CA override must be merged last');
});

test('wiki-workspace seeds the overrides once and merges them in both stacks', async () => {
  const script = await readFile(new URL('../../wiki-workspace', import.meta.url), 'utf8');

  assert.match(script, /ensure_compose_override\(\) \{/);
  // Seed-once contract: the opposite of cacert_compose_args, which always
  // replaces its generated file.
  assert.match(script, /\[\[ -f "\$target" \]\] && return 0/);
  assert.match(script, /ensure_compose_override 'agents\.docker-compose\.override\.example\.yml' 'agents\.docker-compose\.override\.yml'/);
  assert.match(script, /ensure_compose_override 'docker-compose\.override\.example\.yml' 'docker-compose\.override\.yml'/);
  assert.match(script, /local user_override="\$MANAGER_STATE_DIR\/docker-compose\.override\.yml"/);
  assert.match(
    script,
    /-f "\$ROOT_DIR\/docker-compose\.yml" \$\{override_args\[@\]\+"\$\{override_args\[@\]\}"\} \$\{cacert_args\[@\]\+"\$\{cacert_args\[@\]\}"\}/,
  );
});
