#!/usr/bin/env bun

import '@opentui/solid/preload';

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
  const argv = process.argv.slice(2);
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !argv.includes('--headless') && !argv.includes('--once') && !argv.includes('--version') && !argv.includes('-v') && !argv.includes('--help') && !argv.includes('-h');
  if (interactive) process.stdout.write('Starting wiki-manager…\r');
  const { runCli } = await import('../src/cli/wiki-manager.js');
  await runCli(argv);
}

main().catch((err) => {
  console.error(formatStartupError(err));
  process.exit(1);
});
