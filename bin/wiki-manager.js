#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function stripOptionWithValue(argv, flag) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      index += 1;
      continue;
    }
    result.push(argv[index]);
  }
  return result;
}

function cacertEnvVars(cacert) {
  return {
    WIKI_MANAGER_CACERT_PATH: cacert,
    NODE_EXTRA_CA_CERTS: cacert,
    SSL_CERT_FILE: cacert,
    REQUESTS_CA_BUNDLE: cacert,
    CURL_CA_BUNDLE: cacert,
  };
}

function resolveCacert(argv) {
  const cacert = valueAfter(argv, '--cacert');
  if (!cacert) return { argv, cacert: null };
  const absolute = resolve(cacert);
  if (!existsSync(absolute)) {
    throw new Error(`--cacert file not found: ${absolute}`);
  }
  return {
    argv: stripOptionWithValue(argv, '--cacert'),
    cacert: absolute,
  };
}

async function reexecWithCacertIfNeeded(argv, cacert) {
  if (!cacert || process.env.WIKI_MANAGER_CACERT_BOOTSTRAPPED === '1') return;
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env, WIKI_MANAGER_CACERT_BOOTSTRAPPED: '1', ...cacertEnvVars(cacert) };
  const result = spawnSync(process.execPath, [process.argv[1], ...argv], {
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function formatStartupError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? err.code : null;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return [
      `Startup error: ${message}`,
      '',
      'Check that you are running this command from the wiki-manager package directory:',
      '  cd llm-wiki-manager',
      '  node ./bin/wiki-manager.js',
      '',
      'If dependencies are missing, run:',
      '  pnpm install',
    ].join('\n');
  }
  return `Startup error: ${message}`;
}

async function main() {
  const parsed = resolveCacert(process.argv.slice(2));
  const argv = parsed.argv;
  await reexecWithCacertIfNeeded(argv, parsed.cacert);
  // Fallback for already-bootstrapped direct invocations; the shell wrapper
  // exports these before Bun starts.
  if (parsed.cacert) Object.assign(process.env, cacertEnvVars(parsed.cacert));
  await import('@opentui/solid/preload');
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !argv.includes('--setup-wizard') && !argv.includes('--headless') && !argv.includes('--once') && !argv.includes('--version') && !argv.includes('-v') && !argv.includes('--help') && !argv.includes('-h');
  if (interactive) process.stdout.write('Starting wiki-manager…\r');
  const { runCli } = await import('../src/cli/wiki-manager.js');
  await runCli(argv);
}

main().catch((err) => {
  console.error(formatStartupError(err));
  process.exit(1);
});
