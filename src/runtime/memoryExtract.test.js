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

test('a second extraction sees the fact the first one just wrote', async () => {
  // Regression: the neighbours were read before awaiting the previous
  // extraction, so two close extractions both saw the pre-write list — the
  // second ADDed a duplicate instead of seeing the key to UPDATE.
  const facts = [];
  const inputs = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const store = {
    search: () => facts.map((fact) => ({ ...fact })),
    extractionNeighbors: () => facts.map((fact) => ({ ...fact })),
    save: ({ key, text, kind }) => {
      const fact = { key: key ?? `key-${facts.length}`, text, kind };
      facts.push(fact);
      return fact;
    },
  };
  let call = 0;
  const llm = { complete: async ({ input }) => {
    call += 1;
    inputs.push(input);
    if (call === 1) {
      await firstGate;
      return JSON.stringify({ operations: [
        { op: 'ADD', kind: 'decision', text: 'Use TAXO.', evidence: 'use TAXO' },
      ] });
    }
    return JSON.stringify({ operations: [] });
  } };
  const first = extractAndApplyMemory({ llm, memoryStore: store, workspace: 'alpha', userText: 'We use TAXO.' });
  const second = extractAndApplyMemory({ llm, memoryStore: store, workspace: 'alpha', userText: 'We use TAXO.' });
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(call, 2);
  assert.equal(facts.length, 1);
  assert.match(inputs[1], /Use TAXO\./);
});
