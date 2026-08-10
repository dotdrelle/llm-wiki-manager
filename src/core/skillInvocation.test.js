import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLegacySkillPlaceholders, explicitSkillReference, matchSkillInvocation, parseSkillArguments } from './skillInvocation.js';
import { formatSkillsForAgent, inspectSkills } from './skills.js';

test('matchSkillInvocation resolves only a real workspace skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-invocation-'));
  mkdirSync(join(root, '.wiki', 'skills'), { recursive: true });
  writeFileSync(join(root, '.wiki', 'skills', 'deliver.md'), '---\nname: deliver\nparams:\n  - template\n  - polish\n---\nDeliver.');
  const match = matchSkillInvocation({ workspacePath: root }, '/deliver "architecture" "improve security"');
  assert.equal(match.skill.name, 'deliver');
  assert.equal(match.rawArgs, '"architecture" "improve security"');
  assert.equal(matchSkillInvocation({ workspacePath: root }, '/status'), null);
});

test('parseSkillArguments preserves one free-form argument and parses quoted multi params', () => {
  assert.deepEqual(parseSkillArguments({ params: ['files'] }, 'document A.md document B.md'), { files: 'document A.md document B.md' });
  assert.deepEqual(parseSkillArguments({ params: ['template', 'polish'] }, '"architecture-juno" "améliorer la sécurité réseau"'), { template: 'architecture-juno', polish: 'améliorer la sécurité réseau' });
});

test('legacy placeholders remain supported and are reported', () => {
  assert.deepEqual(applyLegacySkillPlaceholders('Sync {source}.', { source: 'CME' }), { body: 'Sync CME.', deprecatedPlaceholders: ['source'] });
});

test('reserved skill references require an explicit skill or workflow designation', () => {
  assert.equal(explicitSkillReference('lance le skill status', 'status', 'fr-FR'), true);
  assert.equal(explicitSkillReference('/status comme skill', 'status', 'fr-FR'), true);
  assert.equal(explicitSkillReference('/skills run status', 'status', 'en-US'), true);
  assert.equal(explicitSkillReference('What is the status of the current run?', 'status', 'en-US'), false);
  assert.equal(explicitSkillReference('lance /status', 'status', 'fr-FR'), false);
  assert.equal(explicitSkillReference('lance le skill status', 'status', 'de-DE'), false);
  assert.equal(explicitSkillReference('run the status skill', 'status'), false);
});

test('inspectSkills rejects invalid parameters and case-insensitive name collisions with relative paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-inspection-'));
  const dir = join(root, '.wiki', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'one.md'), '---\nname: Build\ndescription: First\n---\nOne.');
  writeFileSync(join(dir, 'two.md'), '---\nname: build\ndescription: Second\n---\nTwo.');
  writeFileSync(join(dir, 'bad.md'), '---\nname: bad\nparams:\n  - __proto__\n---\nBad.');
  const result = inspectSkills({ workspacePath: root });
  assert.equal(result.skills.length, 0);
  assert.deepEqual(result.rejected.map((item) => item.reason).sort(), ['duplicate_name', 'duplicate_name', 'invalid_param']);
  assert.equal(result.rejected.every((item) => !item.relativePath.startsWith('/')), true);
});

test('catalog renders declared parameters and marks a missing description explicit-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-'));
  const dir = join(root, '.wiki', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deliver.md'), '---\nname: deliver\nparams:\n  - template\n  - polish\n---\nDeliver.');
  const inspection = inspectSkills({ workspacePath: root });
  assert.deepEqual(inspection.warnings.map((item) => item.reason), ['missing_description']);
  assert.match(formatSkillsForAgent({ workspacePath: root }), /\/deliver \[<template> <polish>\]: workflow skill \[explicit name only\]/);
});
