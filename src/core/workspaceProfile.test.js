import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceProfile } from './profile.js';
import { buildDirectChatSystemPrompt } from '../shell/repl.js';

function workspaceWithProfile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-profile-'));
  if (content !== null) {
    mkdirSync(join(dir, '.wiki'), { recursive: true });
    writeFileSync(join(dir, '.wiki', 'profile.md'), content, 'utf8');
  }
  return dir;
}

// Une absence de profil doit dégrader la réponse, jamais la casser : le loader
// est appelé à chaque tour, y compris avant tout /use.
test('a missing workspace, file or empty profile yields null instead of throwing', () => {
  assert.equal(loadWorkspaceProfile(null), null);
  assert.equal(loadWorkspaceProfile(undefined), null);
  assert.equal(loadWorkspaceProfile(workspaceWithProfile(null)), null);
  assert.equal(loadWorkspaceProfile(workspaceWithProfile('   \n\n')), null);
  assert.equal(loadWorkspaceProfile(join(tmpdir(), 'does-not-exist-ever')), null);
});

test('an existing profile is returned trimmed and capped', () => {
  const dir = workspaceWithProfile('\n# Workspace Profile\n\n## Notifications\n\n- Email: ops@example.com\n\n');
  const profile = loadWorkspaceProfile(dir);
  assert.match(profile, /^# Workspace Profile/);
  assert.match(profile, /ops@example\.com$/);

  const huge = workspaceWithProfile('x'.repeat(10_000));
  assert.equal(loadWorkspaceProfile(huge).length, 4000);
});

// Le profil n'était injecté qu'en mode agent : le même workspace répondait avec
// un ton différent selon le mode, et une skill lancée depuis /chat ne pouvait
// pas savoir à qui elle parlait (destinataire de notification, tutoiement…).
// L'injection est volontairement préférée à une entrée profile_read dans
// chatAccess, que le merge additif du scaffold n'aurait jamais propagée aux
// installs existantes.
test('chat mode injects the workspace profile into its system prompt', () => {
  const workspacePath = workspaceWithProfile('# Workspace Profile\n\n## Notifications\n\n- Email: ops@example.com\n');
  const prompt = buildDirectChatSystemPrompt({ workspace: 'demo', workspacePath, language: 'fr-FR' }, []);
  assert.match(prompt, /Workspace profile \(\.wiki\/profile\.md\)/);
  assert.match(prompt, /ops@example\.com/);
});

test('chat mode omits the profile block entirely when there is no profile', () => {
  const prompt = buildDirectChatSystemPrompt({ workspace: 'demo', workspacePath: null, language: 'fr-FR' }, []);
  assert.doesNotMatch(prompt, /Workspace profile/);
  assert.match(prompt, /Reply language: fr-FR\./);
});
