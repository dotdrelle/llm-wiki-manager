import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceContext, loadWorkspaceHelpIndex, readConversationEvents, searchConversationEvents } from './workspaceMemory.js';

test('workspace context reports actual connected and unavailable MCP snapshots without secrets', () => {
  const context = buildWorkspaceContext({ workspace: 'alpha', wikirc: { profile: 'default' }, mcp: {
    ready: { status: 'connected', tools: [{ name: 'read' }] },
    offline: { status: 'disconnected', tools: [], apiKey: 'must-not-leak' },
  } });
  assert.match(context, /"name": "ready"/);
  assert.match(context, /"status": "disconnected"/);
  assert.doesNotMatch(context, /must-not-leak/);
});

test('workspace context announces a bounded catalogue when it has to truncate', () => {
  const notices = [];
  const mcp = Object.fromEntries(Array.from({ length: 35 }, (_, index) => [`connector_${index}`, { status: 'connected', tools: [] }]));
  const session = { workspace: 'alpha', mcp, _onContextNotice: (notice) => notices.push(notice) };
  const context = buildWorkspaceContext(session, { maxChars: 900 });
  assert.match(context, /context\.capped/);
  assert.equal(notices.length, 1);
  buildWorkspaceContext(session, { maxChars: 900 });
  assert.equal(notices.length, 1, 'one cap notice per session avoids log spam');
});

test('workspace help context caches only chapter ids and titles from help_list', async () => {
  let calls = 0;
  const session = { mcp: { wiki: { status: 'connected', tools: [{ name: 'help_list' }] } } };
  const callTool = async () => {
    calls++;
    return { content: [{ type: 'text', text: 'DONNA product documentation — chapters.\n\n04-interaction-modes — Interaction modes\n08-commands-serve — Serve\n\nprivate body must not be read' }] };
  };
  assert.deepEqual(await loadWorkspaceHelpIndex(session, { callTool }), [
    { id: '04-interaction-modes', title: 'Interaction modes' },
    { id: '08-commands-serve', title: 'Serve' },
  ]);
  assert.doesNotMatch(JSON.stringify(session.helpIndex), /private body/);
  await loadWorkspaceHelpIndex(session, { callTool });
  assert.equal(calls, 1);
  assert.match(buildWorkspaceContext(session), /Interaction modes/);
});

test('conversation search and read stay bounded and require exact workspace-filtered ids', () => {
  const events = [
    { conversationId: 'a_thread1', type: 'user_message', payload: { content: 'We selected the blue deployment approach.' }, ts: '2026-01-01' },
    { conversationId: 'a_thread1', type: 'assistant_message', payload: { content: 'The blue approach is documented.' }, ts: '2026-01-02' },
    { conversationId: 'b_thread2', type: 'user_message', payload: { content: 'We selected the green deployment approach.' }, ts: '2026-01-03' },
  ];
  const found = searchConversationEvents(events, 'blue deployment', { excludeConversationId: 'current', limit: 3 });
  assert.equal(found[0].conversationId, 'a_thread1');
  assert.equal(readConversationEvents(events, 'a_thread1').messages.length, 2);
  assert.equal(readConversationEvents(events, 'not-in-workspace'), null);
});
