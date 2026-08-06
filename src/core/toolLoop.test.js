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

// Le tour paraissait figé pendant toute sa durée : la réponse n'apparaissait
// qu'une fois complète, parce que la boucle n'appelait que completeWithTools.
test('streams the answer when the caller asks for deltas', async () => {
  const deltas = [];
  const llm = {
    async completeWithTools() { throw new Error('streamWithTools devait être préféré'); },
    async streamWithTools({ onTextDelta }) {
      onTextDelta('Le wiki ');
      onTextDelta('contient 12 pages.');
      return { content: 'Le wiki contient 12 pages.', tool_calls: [] };
    },
  };

  const out = await runBoundedToolLoop({
    llm,
    tools: [],
    executeCall: async () => 'unused',
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(deltas, ['Le wiki ', 'contient 12 pages.']);
  assert.equal(out.content, 'Le wiki contient 12 pages.');
});

test('keeps the non-streaming path when no delta callback is given', async () => {
  let streamed = false;
  const llm = {
    async completeWithTools() { return { content: 'plain', tool_calls: [] }; },
    async streamWithTools() { streamed = true; return { content: 'streamed', tool_calls: [] }; },
  };

  const out = await runBoundedToolLoop({ llm, tools: [], executeCall: async () => 'unused' });

  assert.equal(streamed, false, 'sans onTextDelta, rien ne doit changer');
  assert.equal(out.content, 'plain');
});

test('discards text emitted by an iteration that ends in tool calls', async () => {
  // Un modèle peut écrire un raisonnement puis décider d'appeler un outil. Ce
  // texte est remplacé par le tour suivant : le laisser afficherait des
  // paragraphes qui disparaissent, pire que pas de streaming du tout.
  let round = 0;
  const deltas = [];
  let resets = 0;
  const llm = {
    async streamWithTools({ onTextDelta }) {
      round += 1;
      if (round === 1) {
        onTextDelta('Je vais regarder…');
        const calls = [toolCall('c1', 'wiki__wiki_list_pages')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      onTextDelta('12 pages.');
      return { content: '12 pages.', tool_calls: [] };
    },
  };

  const out = await runBoundedToolLoop({
    llm,
    tools: [],
    executeCall: async () => 'ok',
    onTextDelta: (delta) => deltas.push(delta),
    onTextReset: () => { resets += 1; },
  });

  assert.deepEqual(deltas, ['Je vais regarder…', '12 pages.']);
  assert.equal(resets, 1, 'le texte intermédiaire doit être annulé, une fois');
  assert.equal(out.content, '12 pages.');
});

test('never asks to discard text that was never emitted', async () => {
  let resets = 0;
  let round = 0;
  const llm = {
    async streamWithTools() {
      round += 1;
      if (round === 1) {
        const calls = [toolCall('c1', 'wiki__wiki_list_pages')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      return { content: 'fini', tool_calls: [] };
    },
  };

  await runBoundedToolLoop({
    llm,
    tools: [],
    executeCall: async () => 'ok',
    onTextDelta: () => {},
    onTextReset: () => { resets += 1; },
  });

  assert.equal(resets, 0);
});
