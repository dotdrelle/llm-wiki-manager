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
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { say } from './donnaVoice.js';

// Kept as the entry point of runner.js and the supervisor; the wording, the
// language and the degradation are donnaVoice.js's.
export async function phraseFactsForUser(session, facts, { signal = null, rules = [] } = {}) {
  const factLine = String(facts ?? '').trim();
  if (!factLine) return '';
  return say(session, { kind: 'run_facts', facts: factLine, sentences: 2, rules, signal, timeoutMs: 20_000 });
}

// The evaluator's verdict is a fact like any other. It used to be pushed raw —
// an English sentence in a French workspace, a French one in every other.
export function evaluationMessageForUser(session, evaluation, { awaitingInput = false, signal = null } = {}) {
  const reason = String(evaluation?.reason ?? '').trim() || 'none given';
  const suggested = evaluation?.suggestedAction ? ` Suggested action: ${evaluation.suggestedAction}.` : '';
  if (awaitingInput) {
    return phraseFactsForUser(session, `The run stopped because it needs the user's input before acting. Pending question: ${reason}.${suggested}`, { signal, rules: [
      'Ask the user the pending question; do not call it a failure.',
    ] });
  }
  if (evaluation?.severity === 'warning') {
    return phraseFactsForUser(session, `The run's work is done and kept. The final check raises a WARNING, not a failure: ${reason}.${suggested}`, { signal, rules: [
      'Say the work is done, then give the warning and, when present, the suggested action. Never call it a failure or an error.',
    ] });
  }
  return phraseFactsForUser(session, `The run's work ran and is kept (nothing was undone), but the final check judged the objective incomplete. Reason: ${reason}.${suggested}`, { signal, rules: [
    'Say that what was done stays done, then state the reason the check gives and, when present, the suggested action. Never claim the work failed to run, nor that it fully succeeded.',
  ] });
}

// The run's own tool calls and their outcome, as evaluator input: without them
// the evaluator saw only Donna's closing claim and judged a real write "not
// verifiable". The projection's chain is reset at each run_started.
export function formatRunToolCalls(chain, max = 20) {
  const bounded = (value, n) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  return (Array.isArray(chain) ? chain : [])
    .filter((step) => step?.type === 'tool' && step.name)
    .slice(-max)
    .map((step) => `- ${step.name} ${bounded(JSON.stringify(step.args ?? {}), 300)}: ${step.status}${step.summary && step.summary !== step.status ? ` — ${bounded(step.summary, 300)}` : ''}`)
    .join('\n');
}

// The work ran and is kept; the check only found a convention not met. A
// warning, not a failure: the run ends done, the control item carries it, and
// Donna says it — the chain shows amber, never red.
export async function finishWithEvaluationWarning(session, evaluation, { runId, signal }) {
  dispatchAgentEvent(session, createAgentEvent('assistant_message', {
    origin: 'runtime', runId, payload: { content: await evaluationMessageForUser(session, evaluation, { signal }) },
  }));
  dispatchAgentEvent(session, createAgentEvent('run_done', { origin: 'runtime', runId, payload: { runId, warning: evaluation.reason } }));
  return { ok: true, evaluation, warning: true };
}
