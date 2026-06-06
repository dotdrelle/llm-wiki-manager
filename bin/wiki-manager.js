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
  const { runCli } = await import('../src/cli/wiki-manager.js');
  await runCli(process.argv.slice(2));
}

main().catch((err) => {
  console.error(formatStartupError(err));
  process.exit(1);
});
