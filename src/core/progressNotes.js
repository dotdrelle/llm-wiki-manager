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

// The tool's main arguments ride along: "Using tavily.search" says which
// connector is busy, not what it is looking for.
export function toolStartNote(name, argsSummary = '') {
  return `Using ${name || 'a tool'}${argsSummary ? ` (${argsSummary})` : ''}…`;
}

const MAX_SPINNER_ARG_LENGTH = 96;

// The argument a reader would recognise as the request itself — a delegated
// objective, a search question — whole rather than cut at 36 characters. Chosen
// by shape, not by tool (no catalogue): the first string argument written as a
// phrase, at least three words. An id, a path or a key has no spaces, so a
// token or a password is never chosen.
export function toolArgumentSubject(rawArguments, limit = 200) {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    for (const value of Object.values(parsed ?? {})) {
      if (typeof value !== 'string') continue;
      const text = value.replace(/\s+/g, ' ').trim();
      if (text.split(' ').length >= 3) return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
    }
  } catch { /* not JSON: no subject */ }
  return '';
}

export function summarizeToolArguments(rawArguments) {
  if (!rawArguments || rawArguments === '{}') return '';
  try {
    const parsed = JSON.parse(rawArguments);
    const entries = Object.entries(parsed ?? {});
    if (entries.length === 0) return '';
    const summary = entries
      .slice(0, 4)
      .map(([key, value]) => {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}=${String(rendered).replace(/\s+/g, ' ').slice(0, 36)}`;
      })
      .join(', ');
    return summary.length > MAX_SPINNER_ARG_LENGTH
      ? `${summary.slice(0, MAX_SPINNER_ARG_LENGTH - 3)}...`
      : summary;
  } catch {
    return String(rawArguments).replace(/\s+/g, ' ').slice(0, MAX_SPINNER_ARG_LENGTH);
  }
}

function noteReason(detail) {
  const compact = String(detail ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  try {
    const parsed = JSON.parse(compact);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const reason = parsed.reason;
      return typeof reason === 'string' && reason.trim() ? reason.trim() : '';
    }
  } catch {
    // Not JSON: the detail is the reason itself.
  }
  return compact;
}

export function toolResultNote(name, ok, detail) {
  const tool = name || 'the tool';
  const reason = noteReason(detail);
  if (ok === false) {
    return reason ? `${tool} failed: ${reason}` : `${tool} failed.`;
  }
  return reason ? `${tool} done: ${reason}` : `${tool} done.`;
}

