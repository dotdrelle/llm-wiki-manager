import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSensitiveMemoryMaterial, extractAndApplyMemory } from './memoryExtract.js';

test('automatic extraction accepts only facts with exact user-provided evidence', async () => {
  const saved = [];
  const notices = [];
  const store = {
    search: () => [],
    save: (value) => { saved.push(value); return { ...value, key: value.key ?? 'new-key' }; },
  };
  const result = await extractAndApplyMemory({
    workspace: 'alpha', conversationId: 'conv_alpha_1', turnId: 'turn-1',
    userText: 'We decided: use TAXO for every ingest.',
    llm: { complete: async () => JSON.stringify({ operations: [
      { op: 'ADD', kind: 'decision', text: 'Use TAXO for every ingest.', evidence: 'use TAXO for every ingest' },
      { op: 'ADD', kind: 'decision', text: 'Use a different engine.', evidence: 'the assistant said so' },
    ] }) },
    memoryStore: store, onNotice: (message) => notices.push(message),
  });
  assert.equal(result.length, 1);
  assert.equal(saved[0].workspace, 'alpha');
  assert.equal(saved[0].evidence[0].turnId, 'turn-1');
  assert.ok(notices.some((line) => line.includes('rejected')));
});

test('automatic extraction does not call the model for greetings or without a workspace', async () => {
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return '{"operations":[]}'; } };
  const memoryStore = { search: () => [], save: () => { throw new Error('should not save'); } };
  await extractAndApplyMemory({ llm, memoryStore, workspace: 'alpha', userText: 'Bonjour !' });
  await extractAndApplyMemory({ llm, memoryStore, workspace: null, userText: 'Keep the answer concise.' });
  assert.equal(calls, 0);
});

test('messages containing credential-shaped values are skipped before extraction', async () => {
  let calls = 0;
  const notices = [];
  const llm = { complete: async () => { calls++; return { operations: [] }; } };
  assert.equal(containsSensitiveMemoryMaterial('The deployment password: correct-horse-battery-staple'), true);
  assert.equal(containsSensitiveMemoryMaterial('We decided to use TAXO for ingest.'), false);
  assert.deepEqual(await extractAndApplyMemory({
    llm, memoryStore: {}, workspace: 'alpha', userText: 'The deployment password: correct-horse-battery-staple',
    onNotice: (notice) => notices.push(notice),
  }), []);
  assert.equal(calls, 0);
  assert.match(notices[0], /credential or secret/);
});
