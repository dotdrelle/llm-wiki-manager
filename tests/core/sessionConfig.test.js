import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySessionWikircProfile,
  readActiveProfileName,
  syncSessionWikirc,
  wikircSyncNotice,
} from '../../src/core/sessionConfig.js';
import { loadWorkspaceSystemPrompt } from '../../src/core/profile.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'session-config-'));
  writeFileSync(join(dir, '.wikirc.yaml'), 'language: fr\nllm:\n  provider: openai-compatible\n  baseUrl: http://localhost:1\n  model: model-a\n');
  writeFileSync(join(dir, '.wikirc.yaml.fast'), 'language: en\nllm:\n  provider: openai-compatible\n  baseUrl: http://localhost:1\n  model: model-b\n');
  return dir;
}

function sessionOn(dir) {
  return { workspace: 'ws', workspacePath: dir };
}

test('a switch is persisted in the workspace and followed by another process session', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shell = sessionOn(dir);
  const runtime = sessionOn(dir);
  applySessionWikircProfile(shell, 'default');
  applySessionWikircProfile(runtime, 'default');

  applySessionWikircProfile(runtime, 'fast', { persist: true });
  assert.equal(readActiveProfileName(dir), '.wikirc.yaml.fast');

  const result = syncSessionWikirc(shell);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'switched');
  assert.equal(shell.wikirc.profile, 'fast');
  assert.equal(shell.wikircConfig.llm.model, 'model-b');
  assert.equal(shell.language, 'en');
  assert.match(wikircSyncNotice(result), /switched to "fast" \(was "default"\)/);
  // Nothing changed since: no reload, no notice.
  assert.deepEqual(syncSessionWikirc(shell), { changed: false });
});

test('an edit of the active profile file is reloaded at the next sync', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = sessionOn(dir);
  applySessionWikircProfile(session, 'default');
  writeFileSync(join(dir, '.wikirc.yaml'), 'language: de\nllm:\n  provider: openai-compatible\n  baseUrl: http://localhost:1\n  model: model-c\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(join(dir, '.wikirc.yaml'), later, later);

  const result = syncSessionWikirc(session);
  assert.equal(result.reason, 'edited');
  assert.equal(session.wikircConfig.llm.model, 'model-c');
  assert.equal(session.language, 'de');
});

test('a persisted profile that no longer loads keeps the current one and says so once', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = sessionOn(dir);
  applySessionWikircProfile(session, 'default');
  applySessionWikircProfile(sessionOn(dir), 'fast', { persist: true });
  rmSync(join(dir, '.wikirc.yaml.fast'));

  const first = syncSessionWikirc(session);
  assert.equal(first.changed, false);
  assert.match(first.error, /".wikirc.yaml.fast" could not be loaded/);
  assert.equal(session.wikirc.profile, 'default');
  assert.deepEqual(syncSessionWikirc(session), { changed: false });
});

test('the workspace system prompt is read from disk at every call', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadWorkspaceSystemPrompt(dir), null);
  mkdirSync(join(dir, '.wiki'), { recursive: true });
  writeFileSync(join(dir, '.wiki', 'system-prompt.md'), 'First instructions.\n');
  assert.equal(loadWorkspaceSystemPrompt(dir), 'First instructions.');
  writeFileSync(join(dir, '.wiki', 'system-prompt.md'), 'Edited instructions.\n');
  assert.equal(loadWorkspaceSystemPrompt(dir), 'Edited instructions.');
});

test('two profiles both named "default" are told apart by their file', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.wikirc.yaml.default'), 'language: it\nllm:\n  provider: openai-compatible\n  baseUrl: http://localhost:1\n  model: model-d\n');
  const shell = sessionOn(dir);
  const runtime = sessionOn(dir);
  applySessionWikircProfile(shell, 'default');
  applySessionWikircProfile(runtime, 'default');
  assert.equal(shell.wikirc.fileName, '.wikirc.yaml');

  applySessionWikircProfile(runtime, '.wikirc.yaml.default', { persist: true });
  assert.equal(readActiveProfileName(dir), '.wikirc.yaml.default');
  const result = syncSessionWikirc(shell);
  assert.equal(result.reason, 'switched');
  assert.equal(shell.wikirc.fileName, '.wikirc.yaml.default');
  assert.equal(shell.wikircConfig.llm.model, 'model-d');
  assert.deepEqual(syncSessionWikirc(shell), { changed: false });
});
