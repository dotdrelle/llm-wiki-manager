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
export async function runBoundedToolLoop({
  llm,
  system,
  messages,
  tools,
  executeCall,
  maxIterations = 4,
  signal,
  onStep,
} = {}) {
  const cap = Math.max(1, Math.floor(maxIterations) || 1);
  const convo = [...(messages ?? [])];
  for (let i = 0; i < cap; i += 1) {
    onStep?.(i + 1, cap);
    const result = await llm.completeWithTools({
      system,
      tools,
      messages: convo,
      toolChoice: 'auto',
      signal,
    });
    const calls = result?.tool_calls ?? [];
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
