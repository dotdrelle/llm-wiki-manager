import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scriptPath = fileURLToPath(new URL('../../wiki-workspace', import.meta.url));

// Extracts the pure env-file helpers from wiki-workspace and exercises them for
// real: these functions rewrite the operator's .env in place, so a source-grep
// assertion would not catch an off-by-one in the comment matching.
function bashHelpers() {
  const script = readFileSync(scriptPath, 'utf8');
  return ['commented_assignment', 'set_env_value', 'env_value']
    .map((name) => {
      const start = script.indexOf(`\n${name}() {`);
      assert.ok(start >= 0, `missing helper: ${name}`);
      const end = script.indexOf('\n}\n', start);
      assert.ok(end > start, `unterminated helper: ${name}`);
      return script.slice(start, end + 3);
    })
    .join('\n');
}

function runHelpers(envContent, commands) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-manager-setenv-'));
  const envFile = join(dir, '.env');
  const runner = join(dir, 'run.sh');
  writeFileSync(envFile, envContent, 'utf8');
  writeFileSync(runner, `set -euo pipefail\n${bashHelpers()}\nf="${envFile}"\n${commands}\n`, 'utf8');
  execFileSync('bash', [runner], { encoding: 'utf8' });
  return readFileSync(envFile, 'utf8');
}

test('a generated key reuses its commented placeholder instead of being appended', () => {
  const result = runHelpers(
    '# Generated automatically when missing.\n# OAUTH_STATE_SECRET=\n# OAUTH_START_TOKEN=\n',
    'set_env_value "$f" OAUTH_STATE_SECRET aaa\n',
  );

  assert.match(result, /^OAUTH_STATE_SECRET=aaa$/m);
  // The value must land on the placeholder's own line, under the comment block
  // that documents it — not orphaned at the end of the file.
  assert.doesNotMatch(result, /^#\s*OAUTH_STATE_SECRET=/m);
  assert.ok(
    result.indexOf('OAUTH_STATE_SECRET=aaa') < result.indexOf('# OAUTH_START_TOKEN='),
    'the placeholder line must be replaced in place',
  );
  // A sibling placeholder nobody asked for stays commented.
  assert.match(result, /^# OAUTH_START_TOKEN=$/m);
});

test('placeholder matching tolerates the spacing variants shipped in .env.example', () => {
  const result = runHelpers(
    '#GOOGLE_OAUTH_CALLBACK_URL=http://old\n##  WIKI_MANAGER_RUNTIME_TOKEN=\n',
    'set_env_value "$f" GOOGLE_OAUTH_CALLBACK_URL http://new\nset_env_value "$f" WIKI_MANAGER_RUNTIME_TOKEN ccc\n',
  );

  assert.equal(result, 'GOOGLE_OAUTH_CALLBACK_URL=http://new\nWIKI_MANAGER_RUNTIME_TOKEN=ccc\n');
});

test('an active assignment wins and never gains a second uncommented twin', () => {
  const result = runHelpers(
    '# A prose comment mentioning NO_PROXY without assigning it\nNO_PROXY=keepme\n# NO_PROXY=should-stay-commented\n',
    'set_env_value "$f" NO_PROXY localhost\n',
  );

  assert.match(result, /^NO_PROXY=localhost$/m);
  assert.match(result, /^# NO_PROXY=should-stay-commented$/m);
  assert.match(result, /^# A prose comment mentioning NO_PROXY without assigning it$/m);
  assert.equal(result.match(/^NO_PROXY=/gm).length, 1);
});

test('a key absent from the file is still appended', () => {
  const result = runHelpers('EXISTING=1\n', 'set_env_value "$f" BRAND_NEW_KEY zzz\n');

  assert.match(result, /^EXISTING=1$/m);
  assert.match(result, /^BRAND_NEW_KEY=zzz$/m);
});

test('commented placeholders stay unset for readers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-manager-setenv-read-'));
  const envFile = join(dir, '.env');
  const runner = join(dir, 'run.sh');
  writeFileSync(envFile, '# OAUTH_START_TOKEN=\nCME_MCP_AUTH_TOKEN=set\n', 'utf8');
  writeFileSync(
    runner,
    `set -euo pipefail\n${bashHelpers()}\nenv_value "${envFile}" OAUTH_START_TOKEN "<unset>"\nenv_value "${envFile}" CME_MCP_AUTH_TOKEN "<unset>"\n`,
    'utf8',
  );
  const output = execFileSync('bash', [runner], { encoding: 'utf8' });

  assert.equal(output, '<unset>\nset\n');
});
