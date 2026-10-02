import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLegacySkillPlaceholders, explicitSkillReference, matchSkillInvocation, parseSkillArguments, unknownSkillInvocation } from './skillInvocation.js';
import { formatSkillsForAgent, inspectSkills } from './skills.js';

test('matchSkillInvocation resolves only a real workspace skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-invocation-'));
  mkdirSync(join(root, '.wiki', 'skills'), { recursive: true });
  writeFileSync(join(root, '.wiki', 'skills', 'deliver.md'), '---\nname: deliver\nparams:\n  - deliverable\n  - polish\n---\nDeliver.');
  const match = matchSkillInvocation({ workspacePath: root }, '/deliver "architecture" "improve security"');
  assert.equal(match.skill.name, 'deliver');
  assert.equal(match.rawArgs, '"architecture" "improve security"');
  assert.equal(matchSkillInvocation({ workspacePath: root }, '/status'), null);
});

test('parseSkillArguments preserves one free-form argument and parses quoted multi params', () => {
  assert.deepEqual(parseSkillArguments({ params: ['files'] }, 'document A.md document B.md'), { files: 'document A.md document B.md' });
  assert.deepEqual(parseSkillArguments({ params: ['deliverable', 'polish'] }, '"architecture-demo" "improve the network security"'), { deliverable: 'architecture-demo', polish: 'improve the network security' });
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

test('skills declare whether execution is orchestrated or direct', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-execution-'));
  const dir = join(root, '.wiki', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'direct.md'), '---\nname: direct\ndescription: Direct action\nexecution: direct\n---\nAct directly.');
  writeFileSync(join(dir, 'default.md'), '---\nname: default\ndescription: Delegated action\n---\nDelegate when needed.');
  writeFileSync(join(dir, 'invalid.md'), '---\nname: invalid\ndescription: Invalid policy\nexecution: magical\n---\nNo.');

  const result = inspectSkills({ workspacePath: root });
  assert.equal(result.skills.find((skill) => skill.name === 'direct')?.execution, 'direct');
  assert.equal(result.skills.find((skill) => skill.name === 'default')?.execution, 'orchestrated');
  assert.equal(result.rejected.find((item) => item.name === 'invalid')?.reason, 'invalid_execution');
});

test('catalog renders declared parameters and marks a missing description explicit-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-'));
  const dir = join(root, '.wiki', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deliver.md'), '---\nname: deliver\nparams:\n  - deliverable\n  - polish\n---\nDeliver.');
  const inspection = inspectSkills({ workspacePath: root });
  assert.deepEqual(inspection.warnings.map((item) => item.reason), ['missing_description']);
  assert.match(formatSkillsForAgent({ workspacePath: root }), /\/deliver \[<deliverable> <polish>\]: workflow skill \[explicit name only\]/);
});

test('unknownSkillInvocation refuses a /name no skill carries, naming what exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-unknown-'));
  mkdirSync(join(root, '.wiki', 'skills'), { recursive: true });
  writeFileSync(join(root, '.wiki', 'skills', 'wiki-ingest.md'), '---\nname: wiki-ingest\ndescription: Ingest.\n---\nIngest.');
  const session = { workspacePath: root };

  const unknown = unknownSkillInvocation(session, '/wiki-rebuild');
  assert.equal(unknown.name, 'wiki-rebuild');
  assert.deepEqual(unknown.available, ['/wiki-ingest']);
  assert.match(unknown.message, /Unknown skill \/wiki-rebuild\. Skills available in this workspace: \/wiki-ingest\./);
  // A real skill, a built-in and plain prose are not refused.
  assert.equal(unknownSkillInvocation(session, '/wiki-ingest'), null);
  assert.equal(unknownSkillInvocation(session, '/status'), null);
  assert.equal(unknownSkillInvocation(session, 'rebuild the wiki please'), null);
});

test('unknownSkillInvocation says when the workspace has no skills at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-none-'));
  const unknown = unknownSkillInvocation({ workspacePath: root }, '/wiki-rebuild');
  assert.deepEqual(unknown.available, []);
  assert.match(unknown.message, /no skills installed \(\.wiki\/skills\/ is missing\)/);
  assert.match(unknown.message, /wiki-workspace wiki <workspace> init/);
});
