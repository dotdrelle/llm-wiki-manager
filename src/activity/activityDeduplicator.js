export function activitySignature(entry = {}) {
  const progress = entry.progress ?? {};
  return JSON.stringify({
    id: entry.id ?? entry.key ?? entry.label ?? null,
    status: normalize(entry.status),
    phase: progress.phase ?? progress.step ?? progress.stepId ?? null,
    progressBucket: progressBucket(progress.percent),
    done: progress.done ?? progress.completed ?? progress.sourceDoneCount ?? null,
    total: progress.total ?? progress.sourceCount ?? null,
    activeAgents: entry.activeAgents ?? progress.activeAgents ?? null,
    error: entry.error ?? null,
    retries: entry.retries ?? progress.retries ?? null,
    approval: entry.approval ?? entry.approvalStatus ?? null,
    blocking: entry.blocking ?? entry.blocked ?? null,
  });
}

export function deduplicateActivities(entries = []) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const signature = activitySignature(entry);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(entry);
  }
  return result;
}

export function visibleActivityEvents(events = []) {
  const visible = [];
  let previous = null;
  for (const event of events) {
    const activity = event?.payload?.activity ?? event?.activity ?? event;
    const signature = activitySignature(activity);
    if (signature !== previous) visible.push(event);
    previous = signature;
  }
  return visible;
}

function progressBucket(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.floor(Math.max(0, Math.min(100, number)) / 5) * 5;
}

function normalize(value) {
  return String(value ?? '').toLowerCase();
}
