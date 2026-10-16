#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureManagerScaffold,
  managerAgentRuntimesFile,
  managerMcpEndpointsFile,
} from '../src/core/env.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const changes = ensureManagerScaffold();
const issues = [];
const notes = [];

function readJson(file, label) {
  if (!existsSync(file)) {
    issues.push(`${label} is missing (${file})`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    issues.push(`${label} is invalid JSON and was left untouched`);
    return undefined;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const exampleEndpoints = readJson(join(packageRoot, 'mcp.endpoints.example.json'), 'Packaged MCP endpoint example');
const endpoints = readJson(managerMcpEndpointsFile(), 'mcp.endpoints.json');
if (exampleEndpoints !== undefined && !object(exampleEndpoints)) issues.push('Packaged MCP endpoint example must contain a JSON object');
if (endpoints !== undefined && !object(endpoints)) issues.push('mcp.endpoints.json must contain a JSON object');
if (object(exampleEndpoints) && object(endpoints)) {
  for (const key of Object.keys(exampleEndpoints)) {
    if (!(key in endpoints)) issues.push(`mcp.endpoints.json is missing packaged key ${key}`);
  }
  const exampleServers = exampleEndpoints.mcpServers;
  const currentServers = endpoints.mcpServers;
  if (object(exampleServers) && object(currentServers)) {
    const disabled = new Set(Array.isArray(endpoints.disabledMcpServers) ? endpoints.disabledMcpServers.map(String) : []);
    for (const name of Object.keys(exampleServers)) {
      if (!(name in currentServers) && !disabled.has(name)) {
        issues.push(`mcp.endpoints.json is missing packaged server ${name}`);
      }
    }
  } else if (currentServers !== null) {
    issues.push('mcp.endpoints.json mcpServers must be an object or explicit null');
  }
}

const exampleRuntimes = readJson(join(packageRoot, 'agent-runtimes.example.json'), 'Packaged agent runtime example');
const runtimeConfig = readJson(managerAgentRuntimesFile(), 'agent-runtimes.json');
if (exampleRuntimes !== undefined && !object(exampleRuntimes) && !Array.isArray(exampleRuntimes)) {
  issues.push('Packaged agent runtime example must contain an array or runtimes array');
}
if (runtimeConfig !== undefined && !object(runtimeConfig) && !Array.isArray(runtimeConfig)) {
  issues.push('agent-runtimes.json must contain an array or object');
}
if (exampleRuntimes !== undefined && runtimeConfig !== undefined) {
  const packagedEntries = Array.isArray(exampleRuntimes) ? exampleRuntimes : exampleRuntimes?.runtimes;
  const configuredEntries = Array.isArray(runtimeConfig) ? runtimeConfig : runtimeConfig?.runtimes;
  if (!Array.isArray(packagedEntries) || !Array.isArray(configuredEntries)) {
    issues.push('agent-runtimes.json must be an array or an object with a runtimes array');
  } else {
    for (const packaged of packagedEntries) {
      const configured = configuredEntries.find((entry) => entry?.id === packaged?.id && entry?.type === packaged?.type);
      if (!configured) {
        notes.push(`${packaged.id}: no matching packaged runtime entry; left the operator runtime selection unchanged`);
        continue;
      }
      if (configured.enabled === false) {
        notes.push(`${packaged.id}: runtime is explicitly disabled; preserved`);
        continue;
      }
      if (!Array.isArray(configured.capabilities)) {
        issues.push(`agent-runtimes.json ${packaged.id} capabilities must be an array`);
        continue;
      }
      const present = new Set(configured.capabilities.map((capability) => capability?.name).filter(Boolean));
      for (const capability of Array.isArray(packaged.capabilities) ? packaged.capabilities : []) {
        if (!present.has(capability?.name)) {
          issues.push(`agent-runtimes.json ${packaged.id} is missing ${capability?.name ?? 'a packaged capability'}`);
        }
      }
    }
  }
}

if (changes.length > 0) {
  console.log(`Applied ${changes.length} packaged configuration migration(s):`);
  for (const change of changes) console.log(`  - ${change}`);
} else {
  console.log('No additive manager configuration changes were needed.');
}
for (const note of notes) console.log(`Preserved by design: ${note}`);
if (issues.length > 0) {
  console.error('Project configuration check failed; refresh stopped before removing containers or images:');
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exitCode = 1;
} else {
  if (notes.length > 0) {
    console.log(`Manager configuration checks passed with ${notes.length} preserved runtime choice(s) to review.`);
  } else {
    console.log('Manager configuration is valid; packaged capabilities are declared for configured runtimes.');
  }
}
