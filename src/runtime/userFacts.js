/*
 System facts reach the user through Donna, never as raw text.

 The runtime knows WHAT happened (a plan outcome, a supervisor decision, a
 verification count); it writes that down as an English fact line — data — and
 Donna words it in the session language. A deterministic sentence appended to
 her answer, or a hardcoded French/English message, is exactly what this
 replaces: every workspace used to get its run outcomes in French, and the
 supervisor's notices in English.

 Without a model (or when the call fails) the English fact line itself is the
 message — data, degraded but never silent and never invented (donnaVoice.js).
 */
import { say } from './donnaVoice.js';

// Kept as the entry point of runner.js and the supervisor; the wording, the
// language and the degradation are donnaVoice.js's.
export async function phraseFactsForUser(session, facts, { signal = null, rules = [] } = {}) {
  const factLine = String(facts ?? '').trim();
  if (!factLine) return '';
  return say(session, { kind: 'run_facts', facts: factLine, sentences: 2, rules, signal, timeoutMs: 20_000 });
}
