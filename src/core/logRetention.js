const DAY_MS = 24 * 60 * 60 * 1000;

/** Sliding age limit for saved maintenance logs, independent of durable decisions. */
export function logRetentionDays(env = process.env) {
  const raw = env.WIKI_MANAGER_LOG_RETENTION_DAYS;
  const days = raw == null || String(raw).trim() === '' ? 15 : Number(raw);
  if (!Number.isSafeInteger(days) || days <= 0 || !Number.isFinite(new Date(Date.now() - days * DAY_MS).getTime())) {
    throw new Error('WIKI_MANAGER_LOG_RETENTION_DAYS must be a positive integer number of days');
  }
  return days;
}

export function logRetentionCutoff(days, now = new Date()) {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}
