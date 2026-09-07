// Deterministic, English-only progress notes Donna publishes during a turn.
//
// Same reasoning as controlMessages.js, and the same trade-off: spending an LLM
// turn to say "I am now calling template_write" would reintroduce exactly the
// per-message cost the orchestration refactor removed, and would double the
// latency of the very turn the note exists to explain. So these are written
// here, deterministically, in English — the one language this lane can
// guarantee — and never localized by a hardcoded fr/en catalog. Donna's own
// localized prose stays what it has always been: the final answer.
//
// They are published as `assistant_progress`, which store.js keeps OUT of the
// persisted event log. That is load-bearing: every persisted event feeds the
// conversation projection, which seeds the next turn's LLM context — so a
// progress note that persisted would be re-read by the model on every later
// turn, growing the context with commentary about work already finished.
//
// Phrasing is generic on purpose. A per-tool verb catalog ("Reading a wiki
// page…", "Writing the template…") reads better for the tools it knows and
// drifts silently the day a tool is added, which is how the shipped help came
// to advertise six skills against eleven. The tool name is data; the sentence
// around it is prose.

export function toolStartNote(name) {
  return `Using ${name || 'a tool'}…`;
}

export function toolResultNote(name, ok, detail) {
  const tool = name || 'the tool';
  if (ok === false) {
    const reason = String(detail ?? '').replace(/\s+/g, ' ').trim();
    return reason ? `${tool} failed: ${reason}` : `${tool} failed.`;
  }
  return `${tool} finished.`;
}

export function turnDoneNote(steps) {
  if (!steps) return 'Done.';
  return `Done — ${steps} step${steps > 1 ? 's' : ''}.`;
}
