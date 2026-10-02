import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStore } from './memoryStore.js';
import { openRuntimeStore } from './store.js';
import { searchConversationEvents } from '../core/workspaceMemory.js';

test('workspace memory is namespaced, searchable, auditable and restorable', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-memory-'));
  const store = openMemoryStore({ stateDir });
  try {
    const fact = store.save({ workspace: 'alpha', key: 'release-policy', text: 'Use TAXO for every wiki ingest', kind: 'decision', conversationId: 'conv_alpha_123', evidence: [{ excerpt: 'Use TAXO' }] });
    store.save({ workspace: 'beta', key: 'release-policy', text: 'Beta uses another ingest mode', kind: 'convention' });
    store.save({ workspace: 'alpha', key: fact.key, text: 'Use TAXO and require anchored citations', kind: 'decision', conversationId: 'conv_alpha_123' });
    assert.equal(store.list('alpha').length, 1);
    assert.equal(store.list('beta').length, 1);
    assert.equal(store.search({ workspace: 'alpha', query: 'anchored citations' })[0].key, 'release-policy');
    const versions = store.history('alpha', 'release-policy');
    assert.equal(versions[0].operation, 'UPDATE');
    assert.match(store.restore({ workspace: 'alpha', key: 'release-policy', historyId: versions[0].id }).text, /Use TAXO for every wiki ingest/);
    assert.equal(store.history('alpha', 'release-policy')[0].operation, 'RESTORE');
    assert.equal(store.get('beta', 'release-policy').text, 'Beta uses another ingest mode');
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('memory tables coexist in the runtime SQLite database', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-memory-runtime-'));
  const runtime = openRuntimeStore({ stateDir });
  const memory = openMemoryStore({ stateDir });
  try {
    memory.save({ workspace: 'alpha', key: 'same-db', text: 'isolated' });
    assert.equal(memory.list('alpha')[0].text, 'isolated');
    assert.deepEqual(runtime.listEvents({ workspace: 'alpha' }), []);
  } finally {
    memory.close();
    runtime.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cross-conversation lookup exposes only a matching title/summary; reading messages is a separate tool step', () => {
  const events = [
    { type: 'user_message', workspace: 'alpha', conversationId: 'conv_current', payload: { content: 'we chose TAXO' } },
    { type: 'user_message', workspace: 'alpha', conversationId: 'conv_old', payload: { content: 'We decided to use anchored provenance for TAXO.' } },
    { type: 'assistant_message', workspace: 'alpha', conversationId: 'conv_old', payload: { content: 'That was the decision.' } },
    { type: 'user_message', workspace: 'alpha', conversationId: 'conv_other', payload: { content: 'Unrelated meeting notes.' } },
  ];
  const found = searchConversationEvents(events, 'TAXO anchored provenance', { excludeConversationId: 'conv_current' });
  assert.equal(found.length, 1);
  assert.equal(found[0].conversationId, 'conv_old');
  assert.equal(found[0].title, 'We decided to use anchored provenance for TAXO.');
  assert.equal('messages' in found[0], false);
});

test('memory store refuses writes without a resolved workspace and bounds fact text', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-memory-'));
  const store = openMemoryStore({ stateDir });
  try {
    assert.throws(() => store.save({ text: 'global fallback must not exist' }), /workspace/i);
    const saved = store.save({ workspace: 'alpha', text: 'x'.repeat(500) });
    assert.equal(saved.text.length, 400);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('lexical retrieval normalizes accents without a language-specific stopword list', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-memory-i18n-'));
  const store = openMemoryStore({ stateDir });
  try {
    store.save({ workspace: 'alpha', key: 'decision', text: 'Décision : conserver le flux TAXO.', kind: 'decision' });
    assert.equal(store.search({ workspace: 'alpha', query: 'decision conserver TAXO', limit: 1 })[0]?.key, 'decision');
  } finally { store.close(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('vector search ranks semantic neighbors when every workspace fact has an embedding', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-memory-vectors-'));
  const store = openMemoryStore({ stateDir });
  try {
    store.save({ workspace: 'alpha', key: 'near', text: 'unrelated words', embedding: [1, 0, 0, 0, 0, 0, 0, 0] });
    store.save({ workspace: 'alpha', key: 'far', text: 'query words', embedding: [0, 1, 0, 0, 0, 0, 0, 0] });
    const result = store.search({ workspace: 'alpha', query: 'unrelated words', queryEmbedding: [1, 0, 0, 0, 0, 0, 0, 0] });
    assert.equal(result[0].key, 'near');
    assert.ok(result[0].vectorScore > result[1].vectorScore);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
