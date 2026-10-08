import test from 'node:test';
import assert from 'node:assert/strict';
import { meterModelCalls } from './modelMeter.js';

test('every model call is journaled with its time and tokens, then one summary', async () => {
  const lines = [];
  const base = {
    config: { model: 'deepseek-flash' },
    async completeWithTools({ onUsage }) { onUsage?.({ prompt_tokens: 4120, completion_tokens: 2310 }); return { content: null, tool_calls: [{ id: 'a' }] }; },
    async complete({ onUsage }) { onUsage?.({ prompt_tokens: 100, completion_tokens: 20 }); return 'ok'; },
    async streamWithTools() { throw new Error('HTTP 429'); },
  };
  const session = { llm: base };
  const finish = meterModelCalls(session, { scope: 'run', log: (line) => lines.push(line) });
  assert.equal(session.llm.config.model, 'deepseek-flash');
  await session.llm.completeWithTools({ messages: [] });
  await session.llm.complete({ input: 'x' });
  await assert.rejects(session.llm.streamWithTools({}));
  const summary = finish();
  assert.equal(session.llm, base);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^model: run call 1 · \d+\.\d s · with tools · in 4120 \/ out 2310 tokens · asked 1 tool call\(s\)$/);
  assert.match(lines[1], /call 2 .* · text · in 100 \/ out 20 tokens$/);
  assert.match(lines[2], /call 3 .* · failed$/);
  assert.match(lines[3], /^model: run total 3 call\(s\) · \d+\.\d s · longest call \d \(\d+\.\d s\) · in 4220 \/ out 2330 tokens$/);
  assert.deepEqual([summary.calls, summary.inputTokens, summary.outputTokens], [3, 4220, 2330]);
});

test('a session is metered once, and a run with no model call says nothing', () => {
  const lines = [];
  const session = { llm: { async complete() { return 'x'; } } };
  const finish = meterModelCalls(session, { log: (line) => lines.push(line) });
  assert.equal(meterModelCalls(session, { log: (line) => lines.push(line) })(), null);
  assert.equal(finish(), null);
  assert.equal(lines.length, 0);
  assert.equal(meterModelCalls({ llm: null })(), null);
});

test('a turn started from a metered workspace client meters its own calls only', async () => {
  const runLines = []; const turnLines = [];
  const base = { async complete() { return 'x'; } };
  const workspace = { llm: base };
  const finishRun = meterModelCalls(workspace, { scope: 'run', log: (line) => runLines.push(line) });
  const turn = { llm: workspace.llm };
  const finishTurn = meterModelCalls(turn, { scope: 'turn', log: (line) => turnLines.push(line) });
  await turn.llm.complete({});
  finishTurn(); finishRun();
  assert.equal(turnLines.filter((line) => /turn call/.test(line)).length, 1);
  assert.equal(runLines.length, 0);
});
