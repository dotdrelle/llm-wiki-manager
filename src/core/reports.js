/*
 Reports: what the thread points to instead of carrying it.

 A long result — a report Donna wrote on request, an agent's final text — is a
 locked file under raw/untracked/Donna/ (llm-wiki services/reportWriter.ts),
 and the message that announces it carries an attachment {kind, target,
 title} the UIs render as a button. Read by shape: any tool answering
 {report: {path, title}} with a path under raw/untracked/ qualifies.
*/

// Beyond this, an agent's final text is a report, not a fact for Donna to
// word: fixed on purpose — it only tells "a sentence" from "a document".
export const LONG_REPORT_CHARS = 1500;
export const LONG_REPORT_LINES = 15;

export function isLongReport(text) {
  const value = String(text ?? '').trim();
  return value.length > LONG_REPORT_CHARS || value.split(/\r?\n/).length > LONG_REPORT_LINES;
}

// Donna's own answer turns into a report beyond twice her prompt's ceiling
// (15-20 lines): only a document-sized reply, never a detailed answer.
export const LONG_ANSWER_CHARS = 3000;
export const LONG_ANSWER_LINES = 30;

export function isLongAnswer(text) {
  const value = String(text ?? '').trim();
  return value.length > LONG_ANSWER_CHARS || value.split(/\r?\n/).length > LONG_ANSWER_LINES;
}

// An explicit request for a saved report is independent of the answer's
// eventual streamed length. The answer is collected first, then summarized
// and written once its complete contents are known.
export function requestsReportDocument(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase();
  return /\b(?:rapport|report)\b/.test(value)
    && /\b(?:faire|fais|fait|rédige|redige|prépare|prepare|crée|cree|génère|genere|produis|écris|ecris|dans|sous forme|as|write|create|make|prepare|generate|draft|produce)\b/.test(value);
}

export function reportFromToolResult(text) {
  try {
    const parsed = JSON.parse(String(text ?? ''));
    const report = parsed?.report;
    const target = String(report?.path ?? '');
    if (!/^raw\/untracked\/.+\.md(?:\.lock)?$/.test(target)) return null;
    return { kind: 'report', target, title: String(report?.title ?? '').slice(0, 160) };
  } catch {
    return null;
  }
}

// A report's title: its first Markdown heading, else the fallback given.
export function reportTitle(text, fallback = '') {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(String(text ?? ''))?.[1];
  const title = String(heading ?? fallback ?? '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}
