import { truncateToolResult } from './mcp.js';

// Minimal, side-effect-free bounded tool-use loop.
//
// This is the shared mechanic of "ask the LLM with a tool set, run the tool
// calls it emits, feed results back, repeat up to a cap". The caller injects
// the ONLY policy that varies: `executeCall(call) -> string` decides whether a
// requested tool is allowed and produces its textual result (allow-list check,
// MCP dispatch, error formatting). The loop itself owns no plan, no delegation,
// no run identity and no agent events — deliberately unlike the /agent
// orchestration loop in createAgentGraph, which is a stateful LangGraph node
// graph and stays separate. Use this for stateless tool-answer turns (e.g.
// /chat read-only questions).
//
// `executeCall` may throw to abort the whole loop (e.g. an AbortError on
// cancel); anything it returns is treated as the tool result for that call.
/**
 * @param onTextDelta appelé au fil de la génération. Une itération qui finit
 *   par des appels d'outils ne produit pas de réponse lisible : ses fragments
 *   sont donc rejetés a posteriori via `onTextReset`, pour ne pas afficher un
 *   raisonnement intermédiaire que le tour suivant remplacera.
 * @param onTextReset appelé quand les fragments déjà émis sont à jeter.
 */
export async function runBoundedToolLoop({
  llm,
  system,
  messages,
  tools,
  executeCall,
  maxIterations = 4,
  signal,
  onStep,
  onTextDelta,
  onTextReset,
} = {}) {
  const cap = Math.max(1, Math.floor(maxIterations) || 1);
  const convo = [...(messages ?? [])];
  // `streamWithTools` accumule les appels d'outils exactement comme
  // `completeWithTools` et renvoie la même forme : le seul écart est qu'il
  // livre le texte au fil de l'eau. Sans lui, la réponse finale n'apparaissait
  // qu'une fois complète — le tour paraissait figé pendant toute sa durée.
  const canStream = typeof onTextDelta === 'function' && typeof llm?.streamWithTools === 'function';
  // The exact same tool + arguments called again is a loop, not progress: a
  // model that keeps re-issuing `search("x")` will never finish, and burning
  // the whole iteration cap on it only produced "could not finish". Track the
  // signatures and stop as soon as a turn repeats one already executed.
  const seen = new Set();
  const signature = (call) => `${call?.function?.name ?? ''}\u0000${String(call?.function?.arguments ?? '')}`;
  let iterations = 0;
  for (let i = 0; i < cap; i += 1) {
    iterations = i + 1;
    onStep?.(i + 1, cap);
    let streamedText = false;
    const result = canStream
      ? await llm.streamWithTools({
          system,
          tools,
          messages: convo,
          toolChoice: 'auto',
          onTextDelta: (delta) => { streamedText = true; onTextDelta(delta); },
          signal,
        })
      : await llm.completeWithTools({
          system,
          tools,
          messages: convo,
          toolChoice: 'auto',
          signal,
        });
    const calls = result?.tool_calls ?? [];
    if (calls.length > 0 && streamedText) onTextReset?.();
    if (calls.length === 0) {
      return {
        content: result?.content ?? result?.message?.content ?? '',
        iterations,
        capped: false,
      };
    }
    if (calls.every((call) => seen.has(signature(call)))) break;
    for (const call of calls) seen.add(signature(call));
    convo.push(result.message ?? { role: 'assistant', content: result.content ?? '', tool_calls: calls });
    // Tool calls within one turn are independent: dispatch concurrently, then
    // replay results in the model's call order so the transcript stays stable.
    // Bound what enters the LLM context, exactly like the /agent loop
    // (graph.js). Without it a wide read — a CME Confluence search at limit 50
    // can weigh ~35 kB — is re-sent on every iteration (up to the cap), and the
    // chat answer pays for tokens the model never needed.
    const outcomes = await Promise.all(calls.map(async (call) => ({
      tool_call_id: call.id,
      content: truncateToolResult(await executeCall(call)),
    })));
    for (const outcome of outcomes) {
      convo.push({ role: 'tool', tool_call_id: outcome.tool_call_id, content: outcome.content });
    }
  }
  // Cap reached or a loop detected: ask once more WITHOUT tools for the best
  // answer the results gathered so far support. Returning '' here is what made
  // a long search end in a dead-end instead of the partial answer it had
  // already collected.
  const content = await finalAnswerWithoutTools({ llm, system, convo, canStream, onTextDelta, onTextReset, signal });
  return { content, iterations, capped: true };
}

async function finalAnswerWithoutTools({
  llm,
  system,
  convo,
  canStream,
  onTextDelta,
  onTextReset,
  signal,
}) {
  try {
    if (canStream) {
      let text = '';
      const result = await llm.streamWithTools({
        system,
        tools: [],
        messages: convo,
        toolChoice: 'auto',
        onTextDelta: (delta) => { text += delta; onTextDelta(delta); },
        signal,
      });
      // A tool call despite the empty toolset is not an answer: drop whatever
      // it streamed and let the caller fall back to its own message.
      if (result?.tool_calls?.length) { onTextReset?.(); return ''; }
      return String(result?.content ?? text ?? '').trim();
    }
    const result = await llm.completeWithTools({
      system,
      tools: [],
      messages: convo,
      toolChoice: 'auto',
      signal,
    });
    if (result?.tool_calls?.length) return '';
    return String(result?.content ?? result?.message?.content ?? '').trim();
  } catch (err) {
    // An abort is the user cancelling, not an empty answer. Swallowing it here
    // made `runBoundedToolLoop` return `{ content: '', capped: true }`, and the
    // caller printed the iteration-limit notice for a turn that was cancelled
    // — the loop's contract is that an abort escapes, and this was the one
    // call that broke it.
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    return '';
  }
}
