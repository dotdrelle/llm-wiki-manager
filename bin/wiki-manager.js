#!/usr/bin/env node
import { runCli } from '../src/cli/wiki-manager.js';

runCli(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
