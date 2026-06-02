export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function formatActivitySummary(source, action, resultText) {
  const text = String(resultText ?? '').trim();
  if (!text) return null;
  const payload = parseJsonText(text);
  const jobId = payload?.jobId ?? payload?.job_id ?? payload?.job?.jobId ?? payload?.job?.job_id;
  const status = payload?.status ?? payload?.job?.status ?? payload?.progress?.status;
  const detail = payload?.message ?? payload?.detail ?? payload?.progress?.detail;
  const structured = [status, jobId ? `job ${jobId}` : null, detail].filter(Boolean).join(' · ');
  if (structured) return `${source}.${action}: ${structured}`;

  const usefulLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /\b(job|job_id|jobId|status|started|running|done|failed|error|warning|complete|completed|created|indexed)\b/i.test(line))
    ?? text.split('\n').map((line) => line.trim()).find(Boolean);
  return usefulLine ? `${source}.${action}: ${usefulLine.slice(0, 120)}` : null;
}

export function formatActivityError(source, action, err) {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cause = lines.find((line) => /cannot connect to the docker daemon/i.test(line))
    ?? lines.find((line) => /\b(error|failed|cannot|unable|denied|missing|not found)\b/i.test(line))
    ?? lines.at(-1)
    ?? message;
  return `${source}.${action}: error · ${cause.slice(0, 120)}`;
}
