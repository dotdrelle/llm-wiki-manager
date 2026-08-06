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
  for (let i = 0; i < cap; i += 1) {
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
        iterations: i + 1,
        capped: false,
      };
    }
    convo.push(result.message ?? { role: 'assistant', content: result.content ?? '', tool_calls: calls });
    // Tool calls within one turn are independent: dispatch concurrently, then
    // replay results in the model's call order so the transcript stays stable.
    const outcomes = await Promise.all(calls.map(async (call) => ({
      tool_call_id: call.id,
      content: await executeCall(call),
    })));
    for (const outcome of outcomes) {
      convo.push({ role: 'tool', tool_call_id: outcome.tool_call_id, content: outcome.content });
    }
  }
  return { content: '', iterations: cap, capped: true };
}
