#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { Console } from 'node:console';

const ROOT = new URL('..', import.meta.url).pathname;
const logger = new Console(process.stdout, process.stderr);
const MAX_LINES = 800;
// Mirrors llm-wiki's scripts/check-file-sizes.js. The manager's largest
// modules are split deliberately not engaged (see the audit's open leads);
// these ceilings record the shipped reality so growth is visible, and they
// drop as extractions land. Raise one only when a change legitimately grows
// that file. `wiki-workspace` is the bash deployment driver, guarded like the
// other sources.
const LEGACY_LIMITS = new Map([
  ['src/runtime/server.js', 2783],
  ['src/shell/repl.js', 2639],
  ['src/agent/graph.js', 2567],
  ['src/cli/wiki-manager.js', 2577],
  ['src/commands/slash.js', 2011],
  ['wiki-workspace', 1845],
  ['src/runtime/store.js', 1834],
  ['src/runtime/runner.js', 1743],
  ['src/shell/SetupWizard.tsx', 1434],
  ['src/core/agentEvents.js', 1414],
  ['src/shell/useSession.ts', 984],
  ['src/orchestrator/dispatcher.js', 982],
  ['src/shell/LeftPane.tsx', 897],
  ['src/core/mcp.js', 813],
]);

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...walk(path));
    else if (/\.(js|ts|tsx)$/.test(path)) entries.push(path);
  }
  return entries;
}

const files = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'bin')),
  join(ROOT, 'wiki-workspace'),
];

const failures = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  const limit = LEGACY_LIMITS.get(rel) ?? MAX_LINES;
  const lines = readFileSync(file, 'utf8').split('\n').length;
  const ok = lines <= limit;
  logger.log(`${ok ? 'ok' : 'FAIL'} ${rel}: ${lines}/${limit}`);
  if (!ok) failures.push({ rel, lines, limit });
}

if (failures.length) {
  logger.error('\nFile size check failed.');
  process.exit(1);
}
