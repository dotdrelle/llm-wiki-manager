/*
 System facts reach the user through Donna, never as raw text.

 The runtime knows WHAT happened (a plan outcome, a supervisor decision, a
 verification count); it writes that down as an English fact line — data — and
 Donna words it in the session language. A deterministic sentence appended to
 her answer, or a hardcoded French/English message, is exactly what this
 replaces: every workspace used to get its run outcomes in French, and the
 supervisor's notices in English.

 Without a model (or when the call fails) the English fact line itself is the
 message: degraded, but never silent and never invented.
 */
export async function phraseFactsForUser(session, facts, { signal = null, rules = [] } = {}) {
  const factLine = String(facts ?? '').trim();
  if (!factLine) return '';
  const llm = session?.llm;
  if (!llm || typeof llm.completeWithTools !== 'function') return factLine;
  const language = session.language ?? 'en-US';
  try {
    const result = await llm.completeWithTools({
      system: [
        'You are Donna, an orchestration assistant reporting runtime facts to the user.',
        `Rephrase the facts in at most two short, natural sentences, in this reply language: ${language}.`,
        'No lists, no headers, no raw job ids — just a concise human summary. Keep every number, every failure and every required intervention.',
        'Never claim more than the facts: a pending, failed, refused or unverified item stays so in your sentence.',
        ...rules,
      ].join('\n'),
      tools: [],
      messages: [{ role: 'user', content: `Facts:\n${factLine}` }],
      signal,
    });
    const phrased = String(result?.content ?? '').trim();
    return phrased || factLine;
  } catch (error) {
    if (signal?.aborted) throw error;
    return factLine;
  }
}
