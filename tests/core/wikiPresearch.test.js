import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSimpleWorkspaceFactQuestion,
  presearchFoundNote,
  wikiCollectContextMessage,
  wikiSearchContextMessages,
} from '../../src/core/wikiPresearch.js';

// The step line after "Searching": counts only, never an excerpt.
test('the pre-search says what it found, in counts', () => {
  const payload = (results) => JSON.stringify({ question: 'q', results });
  assert.equal(
    presearchFoundNote(payload([{ path: 'wiki/a.md', excerpt: 'secret' }, { path: 'wiki/a.md' }, { path: 'wiki/b.md' }])),
    'Wiki search: 3 candidate passages from 2 wiki pages',
  );
  assert.equal(presearchFoundNote(payload([{ path: 'wiki/a.md' }])), 'Wiki search: 1 candidate passage from 1 wiki page');
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
  const page = {
    path: 'wiki/sources/meeting-6.md',
    found: true,
    allowed: true,
    content: '# Meeting 6\nDate: 12 October 2026',
    truncated: false,
  };
  const payload = {
    coverage: { readPageCount: 1, truncatedPageCount: 0 },
    readPages: [page],
    candidateResults: [{ path: page.path, excerpt: 'WIKI_CANDIDATE_PREVIEW_ONLY' }],
    sourceCandidates: [{ path: 'raw/ingested/private.md', evidenceStatus: 'unread' }],
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
    assert.ok(message?.content.includes('WIKI EVIDENCE'));
    assert.ok(message?.content.includes('raw/ingested/private.md'));
    assert.ok(message?.content.includes('"status":"raw-source"'));
    assert.ok(!message?.content.includes('WIKI_CANDIDATE_PREVIEW_ONLY'));
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

function mcpResponse(result) {
  const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => text };
}

function stubWikiMcp(handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const endpoint = `http://wiki-presearch-${Math.random()}.test/mcp`;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'tools/call') {
      calls.push(body);
      return mcpResponse(await handler(body.params.name, body.params.arguments));
    }
    return mcpResponse({
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: { name: 'wiki', version: 'test' },
    });
  };
  return {
    calls,
    session: { mcp: { wiki: { status: 'connected', url: endpoint, tools: [] } } },
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

test('the pre-search reads pages through wiki_collect_context and excludes attached paths', async () => {
  const payload = {
    question: 'compare les options A et B',
    retrieval: { mode: 'hybrid', reason: null },
    coverage: { requestedResultLimit: 8, candidateCount: 1, readPageCount: 1, truncatedPageCount: 0 },
    readPages: [{ path: 'wiki/concepts/a.md', found: true, allowed: true, truncated: false, content: 'PAGE_A_CONTENT' }],
    candidateResults: [{ path: 'wiki/concepts/b.md', excerpt: 'candidate' }],
    notReadRawSources: ['raw/ingested/source.md'],
  };
  const { calls, session, restore } = stubWikiMcp(async () => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }));
  const steps = [];
  try {
    const messages = await wikiSearchContextMessages('compare les options A et B', session, [
      { function: { name: 'wiki__wiki_collect_context' } },
      { function: { name: 'wiki__wiki_search_context' } },
    ], (message) => steps.push(message), ['wiki/concepts/selected.md'], ['wiki/concepts/attached.md']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.name, 'wiki_collect_context');
    assert.deepEqual(calls[0].params.arguments.excludePaths, ['wiki/concepts/attached.md']);
    assert.match(messages[0].content, /WIKI PAGES READ/);
    assert.match(messages[0].content, /PAGE_A_CONTENT/);
    assert.match(messages[0].content, /raw\/ingested\/source\.md/);
    assert.match(messages[0].content, /"ref":"wiki\/concepts\/b\.md"/);
    assert.match(messages[0].content, /"status":"candidate-only"/);
    assert.match(messages[0].content, /"status":"raw-source"/);
    assert.match(messages[0].content, /Only references with status read or partial are evidence/);
    assert.ok(steps.some((message) => /^Wiki read: 1 complete page/.test(message)), steps.join(' | '));
  } finally {
    restore();
  }
});

test('the pre-search labels previews as candidates and strips unread raw-source excerpts', async () => {
  const { calls, session, restore } = stubWikiMcp(async (name) => {
    if (name === 'wiki_collect_context') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            coverage: { requestedResultLimit: 8, candidateCount: 0, readPageCount: 0, truncatedPageCount: 0 },
            readPages: [],
            notReadRawSources: [],
          }),
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: [
            { path: 'wiki/concepts/a.md', excerpt: 'WIKI_CANDIDATE_PREVIEW' },
            { path: 'raw/ingested/source.md', excerpt: 'RAW_SOURCE_PRIVATE_EXCERPT' },
          ],
        }),
      }],
    };
  });
  const steps = [];
  try {
    const messages = await wikiSearchContextMessages('compare les options A et B', session, [
      { function: { name: 'wiki__wiki_collect_context' } },
      { function: { name: 'wiki__wiki_search_context' } },
    ], (message) => steps.push(message));
    assert.deepEqual(calls.map((call) => call.params.name), ['wiki_collect_context', 'wiki_search_context']);
    assert.match(messages[0].content, /WIKI SEARCH CANDIDATES/);
    assert.match(messages[0].content, /WIKI_CANDIDATE_PREVIEW/);
    assert.match(messages[0].content, /raw\/ingested\/source\.md/);
    assert.doesNotMatch(messages[0].content, /RAW_SOURCE_PRIVATE_EXCERPT/);
    assert.match(messages[0].content, /not opened evidence/);
    assert.ok(steps.some((message) => /candidate paths that still need to be opened/.test(message)), steps.join(' | '));
  } finally {
    restore();
  }
});

test('an explicit wiki + Internet request is not skipped by an external service name', async () => {
  const payload = {
    coverage: { requestedResultLimit: 8, candidateCount: 0, readPageCount: 0, truncatedPageCount: 0 },
    readPages: [],
    notReadRawSources: [],
  };
  const { calls, session, restore } = stubWikiMcp(async () => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }));
  try {
    await wikiSearchContextMessages(
      'compare le wiki avec internet en utilisant exa',
      session,
      [
        { function: { name: 'exa__web_search' } },
        { function: { name: 'wiki__wiki_collect_context' } },
      ],
      () => {},
    );
    assert.equal(calls.length, 1, 'the collect runs even though the user named the Exa service');
    assert.equal(calls[0].params.name, 'wiki_collect_context');
  } finally {
    restore();
  }
});
