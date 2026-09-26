import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationCompactionPlan, compactionNoteForDonna, conversationSeed } from './runner.js';
import { createAgentEvent, reduceAgentEvents } from '../core/agentEvents.js';

const exchange = (n) => [
  { role: 'user', content: `question ${n}` },
  { role: 'assistant', content: `réponse ${n}` },
];

test('no compaction while the whole conversation fits the seed window', () => {
  const conversation = [1, 2, 3].flatMap(exchange);
  assert.equal(conversationCompactionPlan({ conversation }), null);
});

test('a message about to leave the window triggers a compaction that keeps the last exchanges', () => {
  const conversation = [1, 2, 3, 4, 5, 6, 7].flatMap(exchange); // 14 > 12
  const plan = conversationCompactionPlan({ conversation });
  assert.equal(plan.reason, 'window');
  assert.equal(plan.keepLast, 6);
  assert.equal(plan.segment.length, 8);
  assert.equal(plan.segment.at(-1).content, 'réponse 4');
});

test('a small-context profile compacts on the budget before the window fills', () => {
  const conversation = [1, 2].flatMap(exchange).map((m) => ({ ...m, content: `${m.content} ${'x'.repeat(900)}` }));
  assert.equal(conversationCompactionPlan({ conversation }, { budgetChars: 100000 }), null);
  const plan = conversationCompactionPlan({ conversation }, { budgetChars: 4000, keepLast: 2 });
  assert.equal(plan.reason, 'budget');
  assert.equal(plan.segment.length, 2);
});

test('the compact boundary keeps the last exchanges verbatim in the seed', () => {
  const events = [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [
    createAgentEvent('user_message', { payload: { content: `question ${n}` } }),
    createAgentEvent('assistant_message', { payload: { content: `réponse ${n}` } }),
  ]);
  events.push(createAgentEvent('conversation_reset', { payload: { summary: 'Résumé 1-4.', keepLast: 6, automatic: true } }));
  const projection = reduceAgentEvents(events);
  const seed = conversationSeed({ agentProjection: projection }, 'rajoute la liste');
  assert.match(seed[0].content, /Résumé 1-4\./);
  assert.deepEqual(seed.slice(1).map((m) => m.content), ['question 5', 'réponse 5', 'question 6', 'réponse 6', 'question 7', 'réponse 7']);
  assert.equal(conversationCompactionPlan(projection), null, 'nothing more to compact');
});

test('Donna is the one who tells the user, in the reply language', () => {
  const note = compactionNoteForDonna(8);
  assert.match(note, /8 oldest messages/);
  assert.match(note, /tell them so in one short sentence, in the reply language/);
});
