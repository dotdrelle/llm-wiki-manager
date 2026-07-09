#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

const managerPackage = readJson('llm-wiki-manager/package.json');
const targetVersion = managerPackage.version;

addCheck('llm-wiki-manager package', targetVersion, targetVersion);
addCheck('llm-wiki package', readJson('llm-wiki/package.json').version, targetVersion);

for (const [relativePath, label] of [
  ['agent-wiki-production/production_mcp_server.py', 'production agent'],
  ['agent-external/agent-cme/cme_mcp_server.py', 'cme agent'],
  ['agent-external/agent-mailer-api/mailer_mcp_server.py', 'mailer agent'],
  ['agent-external/agent-wiki-documents/document_mcp_server.py', 'documents agent'],
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
    'agent-mailer-api',
    'agent-wiki-documents',
    'agent-wiki-production',
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

if (failed.length) {
  console.error(`\nVersion check failed: expected ${targetVersion} everywhere.`);
  process.exit(1);
}
