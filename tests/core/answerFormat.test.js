import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ANSWER_FORMAT_RULE, REPORT_FORMAT_RULE, presentationPromptLines } from '../../src/core/answerFormat.js';
import { buildDirectChatSystemPrompt, createSession } from '../../src/shell/repl.js';
import { buildAgentSystemPrompt } from '../../src/agent/graph.js';
import { activeRuntimeSystemPrompt } from '../../src/orchestrator/dispatcher.js';

// A /status answered in four paragraphs of prose was right and unreadable.
// The renderers already draw safe Markdown; the layout is asked for in words.
test('a conversation outside a messaging thread is asked for the answer format', () => {
  assert.deepEqual(presentationPromptLines(null), [ANSWER_FORMAT_RULE]);
  assert.match(ANSWER_FORMAT_RULE, /one bold line giving the verdict/);
  assert.match(ANSWER_FORMAT_RULE, /> ⚠/);
  assert.match(ANSWER_FORMAT_RULE, /Never write raw HTML or images/);
});

// Tchap has no headings or tables and is read on a phone: its own line wins.
test('a Tchap thread gets its channel line instead of the rich format', () => {
  const lines = presentationPromptLines({ kind: 'tchap' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Tchap messaging thread/);
  assert.doesNotMatch(lines[0], /Answer format/);
});

test('chat and agent prompts carry the answer format, except in a Tchap thread', () => {
  assert.ok(buildDirectChatSystemPrompt({ workspace: 'demo' }, []).includes(ANSWER_FORMAT_RULE));
  assert.ok(!buildDirectChatSystemPrompt({ workspace: 'demo', conversationChannel: { kind: 'tchap' } }, []).includes(ANSWER_FORMAT_RULE));
  assert.ok(buildAgentSystemPrompt({ session: createSession(), input: 'status' }).includes(ANSWER_FORMAT_RULE));
  const tchap = Object.assign(createSession(), { conversationChannel: { kind: 'tchap' } });
  assert.ok(!buildAgentSystemPrompt({ session: tchap, input: 'status' }).includes(ANSWER_FORMAT_RULE));
});

// A maintenance report said "cycle completed" while a proposal waited on the
// user: a report opens on what the user must do.
test('an agent run is asked to open its report on an In brief block', () => {
  assert.match(REPORT_FORMAT_RULE, /quoted "In brief" block of at most three lines/);
  assert.match(REPORT_FORMAT_RULE, /never close a report on "completed"/);
  const prompt = activeRuntimeSystemPrompt({ workspace: 'demo', language: 'fr' }, { requiredCapability: 'agent.curate', operation: 'run' }, { runtimeId: 'gw' }, []);
  assert.ok(prompt.includes(REPORT_FORMAT_RULE));
});
