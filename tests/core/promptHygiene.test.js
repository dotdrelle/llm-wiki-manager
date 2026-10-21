import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentSystemPrompt } from '../../src/agent/graph.js';
import { buildDirectChatSystemPrompt, createSession } from '../../src/shell/repl.js';
import { activeRuntimeSystemPrompt } from '../../src/orchestrator/dispatcher.js';

/*
 Evidence mechanics belong to the tool result and the ledger, not to system
 prompts. If a fix needs a sentence telling the model how to interpret an
 anchor, a truncation or an unread file, the contract is missing — add it at
 the tool boundary instead of teaching one more case here.
*/
test('system prompts do not carry per-case reading mechanics', () => {
  const session = createSession();
  const prompts = [
    buildDirectChatSystemPrompt(session),
    buildAgentSystemPrompt({ session, input: 'summarize the document' }),
    activeRuntimeSystemPrompt(
      { workspace: 'demo' },
      { requiredCapability: 'agent.answer' },
      { capability: {} },
      [{ name: 'wiki', tools: ['wiki_read_page'] }],
    ),
  ];
  for (const prompt of prompts) {
    assert.doesNotMatch(
      prompt,
      /anchor (?:is )?(?:stale|missing|ambiguous)|path before #|Citation anchor|truncated? (?:section|page)/i,
    );
  }
});
