import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStore } from './memoryStore.js';
import { extractAndApplyMemory } from './memoryExtract.js';

test('synthetic workspace corpus keeps 200+ facts, resolves 30 supported contradictions and retrieves the right fact', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wiki-memory-quality-'));
  const memory = openMemoryStore({ stateDir });
  try {
    for (let index = 0; index < 230; index++) {
      memory.save({ workspace: 'quality', key: `artifact-${String(index).padStart(3, '0')}`,
        text: `For artifact-${String(index).padStart(3, '0')}, the required language is French.`, kind: 'convention' });
    }
    const replaced = new Set();
    for (let index = 0; index < 30; index++) {
      const id = `artifact-${String(index).padStart(3, '0')}`;
      const userText = `Correction: for ${id}, the required language is now English.`;
      const result = await extractAndApplyMemory({
        workspace: 'quality', conversationId: `conv_quality_${index}`, turnId: `turn-${index}`,
        userText, memoryStore: memory,
        llm: { complete: async () => JSON.stringify({ operations: [{ op: 'UPDATE', key: id,
          kind: 'convention', text: `For ${id}, the required language is English.`,
          evidence: `for ${id}, the required language is now English` }] }) },
      });
      if (result.length === 1) replaced.add(id);
    }
    assert.equal(memory.list('quality').length, 230, 'updates must not create duplicate facts');
    assert.equal(replaced.size, 30, 'all explicitly evidenced contradictions must replace their prior fact');
    for (let index = 0; index < 230; index++) {
      const id = `artifact-${String(index).padStart(3, '0')}`;
      const result = memory.search({ workspace: 'quality', query: `required language ${id}`, limit: 1 });
      assert.equal(result[0]?.key, id, `top-1 retrieval should identify ${id}`);
      assert.equal(/English/.test(memory.get('quality', id).text), index < 30, `contradiction state for ${id}`);
    }
  } finally {
    memory.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
