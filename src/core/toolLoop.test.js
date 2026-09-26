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

test('stops on a repeated identical tool call instead of burning the cap', async () => {
  const llm = {
    async completeWithTools({ tools }) {
      if (tools.length === 0) return { content: 'Synthèse des résultats.', tool_calls: [] };
      const calls = [toolCall('x', 's__status')];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 's__status' } }],
    executeCall: async () => 'r',
    maxIterations: 8,
  });
  assert.equal(out.capped, true);
  // The same call twice is a loop: it stopped well before the cap.
  assert.ok(out.iterations < 8, `expected an early stop, got ${out.iterations}`);
  // And the turn still answers from what it gathered instead of a dead-end.
  assert.equal(out.content, 'Synthèse des résultats.');
});

test('answers from the gathered results when the cap is reached', async () => {
  let round = 0;
  const llm = {
    async completeWithTools({ tools }) {
      round += 1;
      if (round <= 2 && tools.length > 0) {
        const calls = [toolCall('x', 's__search', `{"q":"${round}"}`)];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      return { content: "Voici ce que j'ai trouvé.", tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 's__search' } }],
    executeCall: async () => 'r',
    maxIterations: 2,
  });
  assert.equal(out.capped, true);
  assert.equal(out.content, "Voici ce que j'ai trouvé.");
});

test('the final answer request is said in words, not only by omitting the tools', async () => {
  // gpt-oss behind vLLM keeps emitting a tool call when the toolset is merely
  // omitted: the turn ended empty and the chat told the user to use /agent.
  let finalMessages = null;
  const llm = {
    async completeWithTools({ tools, messages }) {
      if (tools.length > 0) {
        const calls = [toolCall('x', 's__search', `{"q":"${messages.length}"}`)];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      finalMessages = messages;
      return { content: 'Réponse tirée des résultats.', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 's__search' } }],
    executeCall: async () => 'r',
    maxIterations: 2,
  });
  assert.equal(out.content, 'Réponse tirée des résultats.');
  const last = finalMessages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /No more tool calls/);
});

test('bounds a wide tool result before it enters the LLM context', async () => {
  // A CME Confluence search at limit 50 can weigh ~35 kB and would otherwise be
  // re-sent on every iteration. The /agent loop already truncates at 16 kB
  // (graph.js); the chat loop must not be the one unbounded path.
  let round = 0;
  let toolContent = '';
  const llm = {
    async completeWithTools({ messages }) {
      round += 1;
      if (round === 1) {
        const calls = [toolCall('c1', 'cme__cme_confluence_search')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      toolContent = messages.find((m) => m.role === 'tool')?.content ?? '';
      return { content: 'ok', tool_calls: [] };
    },
  };
  const wide = 'x'.repeat(50000);
  await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 'cme__cme_confluence_search' } }],
    executeCall: async () => wide,
  });
  assert.ok(toolContent.length < wide.length, 'the result must be bounded');
  assert.ok(toolContent.length <= 16200, `bounded length was ${toolContent.length}`);
  assert.match(toolContent, /tronqu/);
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

test('the final request carries no tool call, only the gathered results as text', async () => {
  // Observed on Albert/gpt-oss: eight page reads one per turn, then a ninth
  // read requested at the final step although no tool was offered. A
  // transcript of tool_calls + tool messages is the pattern it continues.
  let finalMessages = null;
  const llm = {
    async completeWithTools({ tools, messages }) {
      if (tools.length > 0) {
        const calls = [toolCall(`c${messages.length}`, 'wiki__wiki_read_page', `{"path":"p${messages.length}.md"}`)];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      finalMessages = messages;
      return { content: 'Anaplan, Pigment, Jedox.', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    messages: [{ role: 'user', content: 'liste des progiciels' }],
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async (call) => `PAGE ${call.function.arguments}`,
    maxIterations: 2,
  });
  assert.equal(out.content, 'Anaplan, Pigment, Jedox.');
  assert.ok(finalMessages.every((m) => m.role !== 'tool' && !m.tool_calls), 'no tool exchange may remain');
  assert.equal(finalMessages.length, 2);
  const evidence = finalMessages.at(-1).content;
  assert.match(evidence, /### Page p1\.md\nPAGE/);
  assert.match(evidence, /p3\.md/);
  assert.match(evidence, /No more tool calls/);
});

test('an empty reply with no tool call asks for the final answer instead of ending empty', async () => {
  let round = 0;
  const llm = {
    async completeWithTools({ tools }) {
      round += 1;
      if (round === 1) {
        const calls = [toolCall('c1', 'wiki__wiki_read_page')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      if (tools.length > 0) return { content: '', tool_calls: null };
      return { content: 'Réponse.', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async () => 'page',
    maxIterations: 8,
  });
  assert.equal(out.content, 'Réponse.');
  assert.equal(out.iterations, 2);
});

test('a failing final call reports its cause instead of passing for the limit', async () => {
  const llm = {
    async completeWithTools({ tools }) {
      if (tools.length === 0) throw new Error('HTTP 429 input tokens per minute exceeded');
      const calls = [toolCall('x', 's__status')];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const out = await runBoundedToolLoop({ llm, tools: [{ function: { name: 's__status' } }], executeCall: async () => 'r', maxIterations: 3 });
  assert.equal(out.content, '');
  assert.match(out.failure, /429/);
});

test('a tool call written as bare JSON text is not shown as the answer', async () => {
  let finals = 0;
  const llm = {
    async completeWithTools({ tools }) {
      if (tools.length > 0) {
        const calls = [toolCall('x', 'wiki__wiki_read_page', '{"path":"a.md"}')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      finals += 1;
      return finals === 1
        ? { content: '{"path":"wiki/concepts/produit/prophix.md"}', tool_calls: null }
        : { content: 'Anaplan et Prophix.', tool_calls: null };
    },
  };
  const out = await runBoundedToolLoop({ llm, tools: [{ function: { name: 'wiki__wiki_read_page' } }], executeCall: async () => 'page', maxIterations: 1 });
  assert.equal(finals, 2, 'one retry of the final request');
  assert.equal(out.content, 'Anaplan et Prophix.');
});

test('an answer written beside a stray tool call at the final step is kept', async () => {
  let finals = 0;
  const llm = {
    async completeWithTools({ tools }) {
      if (tools.length > 0) {
        const calls = [toolCall('x', 'wiki__wiki_read_page', '{"path":"a.md"}')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      finals += 1;
      return { content: 'Anaplan, Pigment.', tool_calls: [toolCall('y', 'wiki__wiki_read_page', '{"path":"b.md"}')] };
    },
  };
  const out = await runBoundedToolLoop({ llm, tools: [{ function: { name: 'wiki__wiki_read_page' } }], executeCall: async () => 'page', maxIterations: 1 });
  assert.equal(out.content, 'Anaplan, Pigment.');
  assert.equal(finals, 1, 'no retry when the text is usable');
  assert.equal(out.failure, undefined);
});

test('a streamed answer beside a stray tool call is neither reset nor dropped', async () => {
  let resets = 0;
  const llm = {
    async streamWithTools({ tools, onTextDelta }) {
      if (tools.length > 0) {
        const calls = [toolCall('x', 'wiki__wiki_read_page', '{"path":"a.md"}')];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      onTextDelta('Réponse finale.');
      return { content: 'Réponse finale.', tool_calls: [toolCall('y', 'wiki__wiki_read_page')] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async () => 'page',
    maxIterations: 1,
    onTextDelta: () => {},
    onTextReset: () => { resets += 1; },
  });
  assert.equal(out.content, 'Réponse finale.');
  assert.equal(resets, 0);
});

test('a free turn does not consume the cap, an ordinary one does', async () => {
  let round = 0;
  const llm = {
    async completeWithTools() {
      round += 1;
      if (round <= 3) {
        const calls = [toolCall(`r${round}`, 'wiki__wiki_read_pages', `{"paths":["p${round}a","p${round}b"]}`)];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      return { content: 'Réponse.', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 'wiki__wiki_read_pages' } }],
    executeCall: async () => 'pages',
    maxIterations: 2,
    isFreeTurn: () => true,
  });
  assert.equal(out.content, 'Réponse.');
  assert.equal(out.capped, false, 'three batch reads under a cap of two');
  assert.equal(out.iterations, 4);
});

test('free turns stay bounded by the cap as a backstop', async () => {
  let round = 0;
  const llm = {
    async completeWithTools({ tools }) {
      if (tools.length === 0) return { content: 'Fin.', tool_calls: [] };
      round += 1;
      const calls = [toolCall(`r${round}`, 'wiki__wiki_read_pages', `{"paths":["a${round}","b${round}"]}`)];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    tools: [{ function: { name: 'wiki__wiki_read_pages' } }],
    executeCall: async () => 'x',
    maxIterations: 2,
    isFreeTurn: () => true,
  });
  assert.equal(out.iterations, 4, 'two free + two counted');
  assert.equal(out.stopReason, 'cap');
});

test('the input budget stops the loop and the final request keeps what fits', async () => {
  let finalMessages = null;
  let round = 0;
  const llm = {
    async completeWithTools({ tools, messages }) {
      if (tools.length === 0) { finalMessages = messages; return { content: 'Partiel.', tool_calls: [] }; }
      round += 1;
      const calls = [toolCall(`r${round}`, 'wiki__wiki_read_page', `{"path":"p${round}.md"}`)];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    system: 'S',
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async () => 'x'.repeat(400),
    maxIterations: 8,
    inputBudgetChars: 1000,
  });
  assert.equal(out.stopReason, 'budget');
  assert.ok(out.iterations < 8);
  assert.equal(out.content, 'Partiel.');
  const evidence = finalMessages.at(-1).content;
  assert.ok(evidence.length < 1400, `final request stays near the budget (${evidence.length})`);
  assert.match(evidence, /left out: over this model's input budget/);
});

test('at the budget the pages read are condensed once and the reading goes on', async () => {
  let round = 0;
  let condenseInput = null;
  let finalMessages = null;
  const llm = {
    async complete({ input }) { condenseInput = input; return 'Anaplan: SaaS [src: wiki/concepts/produit/anaplan.md]'; },
    async completeWithTools({ tools, messages }) {
      round += 1;
      if (round <= 3 && tools.length > 0) {
        const calls = [toolCall(`c${round}`, 'wiki__wiki_read_page', `{"path":"p${round}.md"}`)];
        return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
      }
      finalMessages = messages;
      return { content: 'Réponse, lecture en partie condensée.', tool_calls: [] };
    },
  };
  const out = await runBoundedToolLoop({
    llm,
    system: 'S',
    messages: [{ role: 'user', content: 'quels progiciels ?' }],
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async () => 'x'.repeat(400),
    maxIterations: 8,
    inputBudgetChars: 1000,
  });
  assert.equal(out.condensations, 1);
  assert.equal(out.content, 'Réponse, lecture en partie condensée.');
  assert.match(condenseInput, /QUESTION:\nquels progiciels \?/);
  assert.match(condenseInput, /Page p1\.md/);
  // Donna is told to say it herself; the notes replaced the raw exchanges.
  const notes = finalMessages.find((m) => m.role === 'user' && /condensed into the notes below/.test(m.content));
  assert.ok(notes, 'the condensed notes reach the model');
  assert.match(notes.content, /say in one short sentence/);
  assert.match(notes.content, /anaplan\.md/);
});

test('a failed condensation stops on the budget as before', async () => {
  let round = 0;
  const llm = {
    async complete() { throw new Error('HTTP 500'); },
    async completeWithTools({ tools }) {
      if (tools.length === 0) return { content: 'Partiel.', tool_calls: [] };
      round += 1;
      const calls = [toolCall(`c${round}`, 'wiki__wiki_read_page', `{"path":"p${round}.md"}`)];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const out = await runBoundedToolLoop({
    llm, system: 'S', messages: [{ role: 'user', content: 'q' }],
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async () => 'x'.repeat(400), maxIterations: 8, inputBudgetChars: 1000,
  });
  assert.equal(out.stopReason, 'budget');
  assert.equal(out.condensations, undefined);
  assert.equal(out.content, 'Partiel.');
});

test('the condensed notes survive into the final request', async () => {
  let round = 0;
  let finalEvidence = '';
  const llm = {
    async complete() { return 'NOTES-CONDENSEES'; },
    async completeWithTools({ tools, messages }) {
      if (tools.length === 0) { finalEvidence = messages.at(-1).content; return { content: 'Fin.', tool_calls: [] }; }
      round += 1;
      const calls = [toolCall(`c${round}`, 'wiki__wiki_read_page', `{"path":"p${round}.md"}`)];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  await runBoundedToolLoop({
    llm, system: 'S', messages: [{ role: 'user', content: 'q' }],
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async () => 'x'.repeat(400), maxIterations: 4, inputBudgetChars: 1000,
  });
  assert.match(finalEvidence, /NOTES-CONDENSEES/);
  assert.match(finalEvidence, /end your answer with one short sentence saying so/);
});

test('no condensation when the base request alone nearly fills the budget', async () => {
  let condensed = false;
  const llm = {
    async complete() { condensed = true; return 'notes'; },
    async completeWithTools({ tools }) {
      if (tools.length === 0) return { content: 'Partiel.', tool_calls: [] };
      const calls = [toolCall('c1', 'wiki__wiki_read_page', '{"path":"p.md"}')];
      return { message: { role: 'assistant', content: '', tool_calls: calls }, tool_calls: calls };
    },
  };
  const out = await runBoundedToolLoop({
    llm, system: 'S'.repeat(700), messages: [{ role: 'user', content: 'q' }],
    tools: [{ function: { name: 'wiki__wiki_read_page' } }],
    executeCall: async () => 'x'.repeat(400), maxIterations: 8, inputBudgetChars: 1000,
  });
  assert.equal(condensed, false);
  assert.equal(out.stopReason, 'budget');
});
