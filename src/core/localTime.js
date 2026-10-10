/**
 * How the Shell shows a time: 24 h `HH:MM:SS`, dates `YYYY-MM-DD HH:MM`,
 * always in the local time zone of the machine running the Shell.
 *
 * The runtime STORES its log clocks in UTC (`agentEvents.js` logTime,
 * `runtimeLog.js` timeLabel) — the same lines feed the served chat, whose
 * browser may sit in another zone — so each surface re-expresses them at
 * display time. The served chat has the same rules in
 * `llm-wiki/src/chat/runtime/timeFormatScript.ts`; keep the two identical.
 */

const pad2 = (n) => String(n).padStart(2, '0');

function toLocalDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatLocalTime(value, { seconds = true } = {}) {
  const date = toLocalDate(value);
  if (!date) return '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}${seconds ? `:${pad2(date.getSeconds())}` : ''}`;
}

export function formatLocalDateTime(value, { seconds = false } = {}) {
  const date = toLocalDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatLocalTime(date, { seconds })}`;
}

/** A UTC `HH:MM:SS` clock without a date, as the latest such instant not in the future. */
export function localClockFromUtc(clock, now = new Date()) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(clock ?? ''));
  if (!match) return String(clock ?? '');
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(match[1]), Number(match[2]), Number(match[3])));
  if (date.getTime() - now.getTime() > 60_000) date.setUTCDate(date.getUTCDate() - 1);
  return formatLocalTime(date);
}

/** A runtime log line whose leading UTC clock is shown in local time. */
export function localizeLogLine(line, now = new Date()) {
  const text = String(line ?? '');
  const match = /^(\d{2}:\d{2}:\d{2})(?=\s|$)/.exec(text);
  return match ? localClockFromUtc(match[1], now) + text.slice(match[1].length) : text;
}
