import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSpawnAgent } from '../../src/agent/subagent.js';

function mcpResponse(result) {
  const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => text };
}

test('a spawned subagent gets the read-only pool, runs bounded tools and returns its answer', async () => {
  const originalFetch = globalThis.fetch;
  const endpoint = `http://subagent-${Math.random()}.test/mcp`;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'tools/call') {
      calls.push(body);
      return mcpResponse({ content: [{ type: 'text', text: 'PAGE CONTENT' }] });
    }
    return mcpResponse({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'wiki', version: 'test' } });
  };
  const offered = [];
  let turn = 0;
  const llm = {
    async completeWithTools(request) {
      offered.push(...(request.tools ?? []).map((tool) => tool.function.name));
      turn += 1;
      if (turn === 1) {
        return {
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'wiki__wiki_read_page', arguments: '{"path":"wiki/a.md"}' },
          }],
        };
      }
      return { content: 'SUBAGENT_ANSWER with wiki/a.md', tool_calls: [] };
    },
  };
  const session = {
    mcp: {
      wiki: {
        status: 'connected',
        url: endpoint,
        tools: [
          { name: 'wiki_read_page', annotations: { readOnlyHint: true } },
          { name: 'wiki_write_page' },
        ],
      },
    },
    wikircConfig: { limits: { maxInputTokensPerCall: 50_000 } },
    _abortSignal: new AbortController().signal,
    _onStep: () => {},
  };
  try {
    const result = JSON.parse(await handleSpawnAgent(session, llm, {
      role: 'verifier',
      objective: 'Verify the claim in wiki/a.md',
    }, ['wiki__wiki_read_page', 'wiki__wiki_write_page']));
    assert.equal(result.ok, true);
    assert.match(result.answer, /SUBAGENT_ANSWER/);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'wiki__wiki_read_page');
    assert.equal(calls.length, 1);
    assert.deepEqual([...new Set(offered)], ['wiki__wiki_read_page']);
    assert.deepEqual(
      session.agentEvents.map((event) => event.type),
      ['subagent_started', 'subagent_step', 'subagent_step', 'subagent_finished'],
      'one start, the tool step (running then done), and one finish',
    );
    const timeline = session.agentProjection.subagents[0];
    assert.equal(timeline.subagent, 'verifier');
    assert.equal(timeline.status, 'done');
    assert.deepEqual(timeline.steps, [{ step: 1, tool: 'wiki__wiki_read_page', status: 'done' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a spawned subagent refuses when no read-only tool is available', async () => {
  const session = {
    mcp: { wiki: { status: 'connected', url: 'http://unused.test/mcp', tools: [{ name: 'wiki_write_page' }] } },
    _onStep: () => {},
  };
  const result = JSON.parse(await handleSpawnAgent(session, { completeWithTools: async () => ({ content: '', tool_calls: [] }) }, {
    role: 'writer',
    objective: 'Write the page',
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /No read-only tool/);
});
