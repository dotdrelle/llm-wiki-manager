/*
 The model meter of a run or a turn: every HTTP call to the model, with its
 duration, its tokens and the tool calls it asked for, then one summary.

 Why: a launch that took 33 s before its approval was four model calls, one
 of them 18.6 s — invisible until reconstructed by hand from event
 timestamps. On a smaller model the same turn is where the bottlenecks show;
 they must be read in the journal, not guessed. Content-free by design: no
 prompt, no answer, only counts and timings.
*/
const METERED = ['complete', 'completeWithTools', 'streamWithTools'];

export function meterModelCalls(session, { scope = 'run', log } = {}) {
  // A turn may start from the workspace client while a run meters it: it
  // meters the ORIGINAL client, so the two never count each other's calls.
  const base = session?.llm?.__meterBase ?? session?.llm;
  if (!base || session.__modelMeterActive) return () => null;
  session.__modelMeterActive = true;
  const calls = [];
  const emit = typeof log === 'function' ? log : () => {};
  const metered = Object.create(base);
  metered.__meterBase = base;
  for (const method of METERED) {
    if (typeof base[method] !== 'function') continue;
    metered[method] = async function meteredCall(args = {}) {
      const startedAt = Date.now();
      let usage = null;
      const record = (ok, result) => {
        const call = {
          index: calls.length + 1,
          method,
          ms: Date.now() - startedAt,
          inputTokens: tokenCount(usage?.prompt_tokens ?? usage?.input_tokens),
          outputTokens: tokenCount(usage?.completion_tokens ?? usage?.output_tokens),
          toolCalls: Array.isArray(result?.tool_calls) ? result.tool_calls.length : 0,
          ok,
        };
        calls.push(call);
        emit(`model: ${scope} call ${call.index} · ${formatSeconds(call.ms)} · ${method === 'complete' ? 'text' : 'with tools'}`
          + `${call.inputTokens != null ? ` · in ${call.inputTokens} / out ${call.outputTokens ?? '?'} tokens` : ''}`
          + `${call.toolCalls ? ` · asked ${call.toolCalls} tool call(s)` : ''}${ok ? '' : ' · failed'}`);
      };
      try {
        const result = await base[method].call(this, { ...args, onUsage: (value) => { usage = value; args.onUsage?.(value); } });
        record(true, result);
        return result;
      } catch (error) {
        record(false, null);
        throw error;
      }
    };
  }
  session.llm = metered;
  return function finish() {
    if (session.llm === metered) session.llm = base;
    delete session.__modelMeterActive;
    if (!calls.length) return null;
    const totalMs = calls.reduce((sum, call) => sum + call.ms, 0);
    const longest = calls.reduce((max, call) => (call.ms > max.ms ? call : max), calls[0]);
    const sum = (key) => (calls.some((call) => call[key] != null) ? calls.reduce((total, call) => total + (call[key] ?? 0), 0) : null);
    const summary = { calls: calls.length, totalMs, longest: { index: longest.index, ms: longest.ms }, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens') };
    emit(`model: ${scope} total ${summary.calls} call(s) · ${formatSeconds(totalMs)} · longest call ${longest.index} (${formatSeconds(longest.ms)})`
      + `${summary.inputTokens != null ? ` · in ${summary.inputTokens} / out ${summary.outputTokens ?? '?'} tokens` : ''}`);
    return summary;
  };
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}
