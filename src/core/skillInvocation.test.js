import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLegacySkillPlaceholders, matchSkillInvocation, parseSkillArguments } from './skillInvocation.js';

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
