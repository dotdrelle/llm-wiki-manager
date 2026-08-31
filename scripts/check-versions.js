#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const checks = [];

function readText(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function addCheck(label, actual, expected) {
  checks.push({ label, actual, expected, ok: actual === expected });
}

function matchVersion(relativePath, pattern, label) {
  const text = readText(relativePath);
  const match = pattern.exec(text);
  addCheck(label, match ? match[1] : '<missing>', targetVersion);
}

// Optional siblings: agent-mailer-api and agent-connectors are built and pushed
// by build-and-push.sh but are NOT checked out by llm-wiki-manager's CI, which
// only clones llm-wiki, agent-production, agent-cme and
// agent-documents. A hard check would turn every CI run red, so an absent
// repository is skipped and reported as such; when it IS present — locally and
// in the release script — it is checked like any other.
const skipped = [];

function repoPresent(relativePath) {
  return existsSync(resolve(repoRoot, relativePath));
}

function optionalMatchVersion(relativePath, pattern, label) {
  if (!repoPresent(relativePath)) {
    skipped.push(`${label} (${relativePath} not checked out)`);
    return;
  }
  matchVersion(relativePath, pattern, label);
}

function optionalJsonVersion(relativePath, label, pick = (json) => json.version) {
  if (!repoPresent(relativePath)) {
    skipped.push(`${label} (${relativePath} not checked out)`);
    return;
  }
  addCheck(label, pick(readJson(relativePath)), targetVersion);
}

const managerPackage = readJson('llm-wiki-manager/package.json');
const targetVersion = managerPackage.version;

addCheck('llm-wiki-manager package', targetVersion, targetVersion);
addCheck('llm-wiki package', readJson('llm-wiki/package.json').version, targetVersion);

for (const [relativePath, label] of [
  ['agent-external/agent-production/production_mcp_server.py', 'production agent'],
  ['agent-external/agent-cme/cme_mcp_server.py', 'cme agent'],
  ['agent-external/agent-documents/document_mcp_server.py', 'documents agent'],
]) {
  matchVersion(relativePath, /_AGENT_VERSION\s*=\s*"([^"]+)"/, label);
}

for (const [relativePath, pattern, label] of [
  ['llm-wiki-manager/src/core/mcp.js', /WIKI_MANAGER_VERSION\s*=\s*'([^']+)'/, 'wiki-manager MCP clientInfo'],
  ['llm-wiki/src/commands/serve.ts', /LLM_WIKI_VERSION\s*=\s*'([^']+)'/, 'llm-wiki serve MCP clientInfo'],
  ['llm-wiki/src/services/mcpServer.ts', /LLM_WIKI_VERSION\s*=\s*'([^']+)'/, 'llm-wiki MCP serverInfo'],
  [
    'llm-wiki/src/chat/runtime/mcpConnectorScript.ts',
    /clientInfo:\s*\{name:\s*'WikiChatConnector',\s*version:\s*'([^']+)'\}/,
    'wiki chat connector clientInfo',
  ],
]) {
  matchVersion(relativePath, pattern, label);
}

// Shipped by build-and-push.sh, absent from CI's checkout matrix.
optionalMatchVersion(
  'agent-external/agent-mailer-api/mailer_mcp_server.py',
  /_AGENT_VERSION\s*=\s*"([^"]+)"/,
  'mailer agent',
);
optionalJsonVersion('agent-external/agent-connectors/package.json', 'connectors package');
optionalJsonVersion(
  'agent-external/wiki-agentic-gateway/package.json',
  'gateway package',
);
optionalJsonVersion(
  'agent-external/wiki-agentic-gateway/package-lock.json',
  'gateway package-lock',
  (json) => json.version,
);
optionalJsonVersion(
  'agent-external/wiki-agentic-gateway/package-lock.json',
  'gateway package-lock root package',
  (json) => json.packages?.['']?.version ?? '<missing>',
);
optionalMatchVersion(
  'agent-external/wiki-agentic-gateway/src/config.js',
  /GATEWAY_VERSION\s*\?\?\s*'([^']+)'/,
  'gateway GATEWAY_VERSION default',
);
optionalJsonVersion(
  'agent-external/agent-connectors/package-lock.json',
  'connectors package-lock',
  (json) => json.version,
);
optionalJsonVersion(
  'agent-external/agent-connectors/package-lock.json',
  'connectors package-lock root package',
  (json) => json.packages?.['']?.version ?? '<missing>',
);
optionalMatchVersion(
  'agent-external/agent-connectors/src/server.ts',
  /CONNECTORS_VERSION\s*=\s*'([^']+)'/,
  'connectors MCP serverInfo',
);

if (process.env.CHECK_GIT_TAG === '1') {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: resolve(repoRoot, 'llm-wiki-manager'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    addCheck('git tag', tag, `v${targetVersion}`);
  } catch {
    addCheck('git tag', '<not on exact tag>', `v${targetVersion}`);
  }
}

if (process.env.CHECK_DOCKER_IMAGES === '1') {
  const registryNamespace = process.env.REGISTRY_NAMESPACE || 'dotdrelle';
  const imageSuffixes = [
    'llm-wiki',
    'llm-wiki-manager',
    'agent-cme',
    'agent-documents',
    'agent-production',
    'agent-mailer-api',
    'agent-connectors',
  ];
  for (const suffix of imageSuffixes) {
    const image = `${registryNamespace}/${suffix}`;
    try {
      execFileSync('docker', ['image', 'inspect', `${image}:${targetVersion}`], {
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      addCheck(`docker image ${image}`, targetVersion, targetVersion);
    } catch {
      addCheck(`docker image ${image}`, '<missing>', targetVersion);
    }
  }
}

// Persist build provenance so a packed/global install displays
// `<version>+<sha>` (--version, shell status bar) and any drift between an
// installed copy and the repo is visible at a glance. Runs at
// prepack/prepublishOnly, so every published tarball carries the commit it
// was built from.
try {
  const managerRoot = resolve(repoRoot, 'llm-wiki-manager');
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: managerRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() || null;
  writeFileSync(
    resolve(managerRoot, 'src/core/buildInfo.json'),
    `${JSON.stringify({ version: targetVersion, commit }, null, 2)}\n`,
  );
  console.log(`ok build info: ${targetVersion}+${commit ?? 'dev'}`);
} catch {
  console.log('ok build info: <git unavailable, buildInfo.json not written>');
}

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  const status = check.ok ? 'ok' : 'FAIL';
  console.log(`${status} ${check.label}: ${check.actual}`);
}
for (const note of skipped) {
  console.log(`skip ${note}`);
}

if (failed.length) {
  console.error(`\nVersion check failed: expected ${targetVersion} everywhere.`);
  process.exit(1);
}
