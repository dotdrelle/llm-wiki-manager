// A delegated task's label is its whole objective — for /curate, the skill's
// body with its "## Boundaries" and "## Execution" sections. Every log line of
// the task repeated it, flattened into one paragraph of raw Markdown. A log
// line names the task: its first line, bounded, like the run node's label.
const LOG_LABEL_MAX_CHARS = 100;
export function compactLogLabel(text) {
  const firstLine = String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return firstLine.length > LOG_LABEL_MAX_CHARS ? `${firstLine.slice(0, LOG_LABEL_MAX_CHARS - 1).trimEnd()}…` : firstLine;
}
