/*
 * Coalesces streaming text fragments before they are persisted and pushed.
 *
 * The runtime persisted one SQLite row (plus one SSE write) per streamed token.
 * When a tool pulled a lot of content into the thread, the answer narrating it
 * grew long and those synchronous writes stalled the event loop: both chats
 * (serve and ShellUI) froze while the answer was still being produced. Buffering
 * the fragments and flushing them at a bounded rate turns thousands of writes
 * into a handful without changing what the reader sees.
 *
 * Ordering matters: `flush()` must be called before any non-delta event, or a
 * final message could overtake the fragments that precede it. `reset()` drops
 * buffered text that turned out to be provisional narration (a tool-call
 * iteration), matching `assistant_delta_reset`.
 */
export function createDeltaCoalescer(flush, { intervalMs = 80 } = {}) {
  if (typeof flush !== 'function') throw new TypeError('createDeltaCoalescer requires a flush callback.');
  const delay = Math.max(1, Math.floor(intervalMs) || 80);
  let buffer = '';
  let timer = null;
  const emit = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer) return;
    const delta = buffer;
    buffer = '';
    flush(delta);
  };
  return {
    push(delta) {
      const text = String(delta ?? '');
      if (!text) return;
      buffer += text;
      if (!timer) timer = setTimeout(emit, delay);
    },
    flush: emit,
    reset() {
      buffer = '';
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
