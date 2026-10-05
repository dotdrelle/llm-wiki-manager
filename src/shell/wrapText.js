/**
 * Splits text into lines that fit a TUI box width.
 *
 * The wizard rendered every label, note or error in a `<text height={1}>`:
 * beyond the dialog width the text was cut clean, without ellipsis or hint.
 * The most useful sentences — a step's note, the cause of a connection error
 * — are the longest, hence the most truncated.
 *
 * The module is deliberately plain JavaScript, outside the component: that is
 * what makes it testable without transpiling JSX.
 *
 * @param {string} text text to split; explicit `\n` are respected.
 * @param {number} width usable width in columns.
 * @param {number} maxLines maximum number of lines; the last is marked with
 *   an ellipsis when text remains, so the remaining truncation is at least
 *   visible.
 * @returns {string[]}
 */
export function wrapText(text, width, maxLines = 6) {
  const safeWidth = Math.max(8, Math.floor(width) || 8);
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      // A word longer than the box — a URL, a path, a qualified model name —
      // is cut rather than overflowing: better to read it in two pieces than
      // not at all.
      if (word.length > safeWidth) {
        if (current) {
          lines.push(current);
          current = '';
        }
        for (let i = 0; i < word.length; i += safeWidth) {
          lines.push(word.slice(i, i + safeWidth));
        }
        current = lines.pop() ?? '';
        continue;
      }
      if (!current) current = word;
      else if (current.length + 1 + word.length <= safeWidth) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = `${last.slice(0, Math.max(1, safeWidth - 1))}…`;
  return kept;
}
