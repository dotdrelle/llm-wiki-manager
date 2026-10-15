import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSimpleWorkspaceFactQuestion,
  presearchFoundNote,
  wikiCollectContextMessage,
} from '../../src/core/wikiPresearch.js';

// The step line after "Searching": counts only, never an excerpt.
test('the pre-search says what it found, in counts', () => {
  const payload = (results) => JSON.stringify({ question: 'q', results });
  assert.equal(
    presearchFoundNote(payload([{ path: 'wiki/a.md', excerpt: 'secret' }, { path: 'wiki/a.md' }, { path: 'wiki/b.md' }])),
    'Wiki search: 3 passages from 2 pages',
  );
  assert.equal(presearchFoundNote(payload([{ path: 'wiki/a.md' }])), 'Wiki search: 1 passage from 1 page');
  assert.equal(presearchFoundNote(payload([])), 'Wiki search: nothing found');
  assert.equal(presearchFoundNote('not json'), '');
  assert.equal(presearchFoundNote(JSON.stringify({ other: 1 })), '');
});

test('the fast fact lane accepts short factual questions and excludes report or action requests', () => {
  assert.equal(isSimpleWorkspaceFactQuestion('c quoi la date du dernier copil'), true);
  assert.equal(isSimpleWorkspaceFactQuestion('When was the last steering meeting?'), true);
  assert.equal(isSimpleWorkspaceFactQuestion('Quel est le numéro du dernier comité ?'), true);
  assert.equal(isSimpleWorkspaceFactQuestion('Prépare un rapport sur les réunions du comité'), false);
  assert.equal(isSimpleWorkspaceFactQuestion('Pourquoi la revue a-t-elle échoué ?'), false);
  assert.equal(isSimpleWorkspaceFactQuestion('What is the current workspace status?'), false);
  assert.equal(isSimpleWorkspaceFactQuestion('When was my last email?'), false);
  assert.equal(isSimpleWorkspaceFactQuestion('Ingest the latest Confluence pages'), false);
  assert.equal(isSimpleWorkspaceFactQuestion(''), false);
});

test('the fast wiki lookup accepts only complete pages and caps its local read', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const page = { path: 'wiki/sources/meeting-6.md', content: '# Meeting 6\nDate: 12 October 2026', truncated: false };
  const payload = {
    coverage: { readPageCount: 1, truncatedPageCount: 0 },
    readPages: [page],
    notReadRawSources: [],
  };
  let currentPayload = payload;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const result = body.method === 'tools/call'
      ? { content: [{ type: 'text', text: JSON.stringify(currentPayload) }] }
      : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'wiki', version: 'test' } };
    const text = JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text };
  };
  try {
    const endpoint = `http://wiki-fast-fact-${Math.random()}.test/mcp`;
    const message = await wikiCollectContextMessage('c quoi la date du dernier copil', {
      mcp: { wiki: { status: 'connected', url: endpoint, tools: [] } },
    }, [{ function: { name: 'wiki__wiki_collect_context' } }]);
    assert.ok(message?.content.includes('12 October 2026'));
    assert.equal(calls.filter((call) => call.method === 'tools/call').length, 1);
    assert.equal(calls.find((call) => call.method === 'tools/call').params.arguments.maxResults, 3);
    assert.equal(calls.find((call) => call.method === 'tools/call').params.arguments.maxPageChars, 4000);

    currentPayload = { ...payload, coverage: { readPageCount: 1, truncatedPageCount: 1 } };
    const incomplete = await wikiCollectContextMessage('c quoi la date du dernier copil', {
      mcp: { wiki: { status: 'connected', url: endpoint, tools: [] } },
    }, [{ function: { name: 'wiki__wiki_collect_context' } }]);
    assert.equal(incomplete, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
