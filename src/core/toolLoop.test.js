import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedToolLoop } from './toolLoop.js';

function toolCall(id, name, args = '{}') {
  return { id, function: { name, arguments: args } };
}

test('returns the model answer directly when no tool is called', async () => {
  const llm = {
    async completeWithTools() {
      return { content: 'plain answer', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({ llm, tools: [], executeCall: async () => 'unused' });
  assert.deepEqual(out, { content: 'plain answer', iterations: 1, capped: false });
});

test('dispatches a tool call, feeds the result back, then returns the final answer', async () => {
  let round = 0;
  const seen = [];
  const llm = {
    async completeWithTools({ messages }) {
      round += 1;
      if (round === 1) return { message: { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'cme__cme_status')] }, tool_calls: [toolCall('c1', 'cme__cme_status')] };
      seen.push(messages.find((m) => m.role === 'tool')?.content);
      return { content: 'configured', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 'cme__cme_status' } }],
    executeCall: async (call) => `RESULT(${call.function.name})`,
  });
  assert.equal(out.content, 'configured');
  assert.equal(out.iterations, 2);
  assert.equal(out.capped, false);
  assert.deepEqual(seen, ['RESULT(cme__cme_status)']);
});

test('runs concurrent tool calls and replays results in call order', async () => {
  let round = 0;
  const order = [];
  const llm = {
    async completeWithTools({ messages }) {
      round += 1;
      if (round === 1) {
        const calls = [toolCall('a', 's__list'), toolCall('b', 's__status')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      order.push(...messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      return { content: 'done', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [],
    executeCall: async (call) => call.id,
  });
  assert.equal(out.content, 'done');
  assert.deepEqual(order, ['a', 'b']); // preserved model call order
});

test('reports capped when the model keeps calling tools past the cap', async () => {
  const llm = {
    async completeWithTools() {
      const calls = [toolCall('x', 's__status')];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const out = await runBoundedToolLoop({ llm, tools: [], executeCall: async () => 'r', maxIterations: 3 });
  assert.equal(out.capped, true);
  assert.equal(out.iterations, 3);
});

test('propagates an abort thrown by executeCall', async () => {
  const llm = {
    async completeWithTools() {
      const calls = [toolCall('x', 's__status')];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(
    runBoundedToolLoop({ llm, tools: [], executeCall: async () => { throw abort; } }),
    /aborted/,
  );
});
