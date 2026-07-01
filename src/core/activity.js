export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function basename(value) {
  return String(value ?? '').split('/').filter(Boolean).pop() ?? '';
}

function terminalStatus(status) {
  return ['done', 'failed', 'cancelled', 'canceled', 'complete', 'completed', 'success', 'error'].includes(String(status ?? '').toLowerCase());
}

function activityKey(activity) {
  const id = activity?.id ?? activity?.jobId ?? activity?.job_id;
  const source = activity?.source ?? activity?.agent ?? activity?.poll?.server ?? 'mcp';
  return `${source}:${id ?? activity?.kind ?? activity?.label ?? 'activity'}`;
}

function normalizePlanSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return steps.map((s, i) => ({
    id: s != null && s.id != null ? String(s.id) : String(i + 1),
    label: s != null ? String(s.label ?? s.description ?? s.name ?? s.id ?? (i + 1)) : String(i + 1),
  }));
}

function normalizePoll(poll) {
  if (!poll || typeof poll !== 'object') return null;
  const server = poll.server ?? poll.source ?? poll.agent;
  const tool = poll.tool ?? poll.name;
  if (!server || !tool) return null;
  return {
    server: String(server),
    tool: String(tool),
    args: poll.args && typeof poll.args === 'object' ? poll.args : {},
    intervalMs: Number.isFinite(Number(poll.intervalMs)) ? Math.max(1000, Number(poll.intervalMs)) : 2500,
  };
}

export function normalizeActivity(activity, fallback = {}) {
  if (!activity || typeof activity !== 'object') return null;
  const id = activity.id ?? activity.jobId ?? activity.job_id ?? fallback.id ?? fallback.jobId ?? null;
  const source = activity.source ?? activity.agent ?? fallback.source ?? activity.poll?.server ?? 'mcp';
  const kind = activity.kind ?? activity.type ?? fallback.kind ?? 'job';
  const status = activity.status ?? activity.state ?? fallback.status ?? 'running';
  const progress = activity.progress && typeof activity.progress === 'object' ? activity.progress : {};
  const step = progress.step ?? progress.phase ?? progress.currentStep ?? activity.step ?? activity.currentStep ?? null;
  const percent = Number.isFinite(Number(progress.percent ?? activity.percent))
    ? Number(progress.percent ?? activity.percent)
    : null;
  const stepId = progress.stepId != null ? String(progress.stepId) : null;
  const stepIndex = Number.isFinite(Number(progress.stepIndex)) ? Number(progress.stepIndex) : null;
  const stepTotal = Number.isFinite(Number(progress.stepTotal)) ? Number(progress.stepTotal) : null;
  const rawPlan = activity.plan && typeof activity.plan === 'object' ? activity.plan : null;
  const planSteps = normalizePlanSteps(rawPlan?.steps);
  const label = activity.label ?? [
    source,
    kind,
    step,
  ].filter(Boolean).join(' ');
  const normalized = {
    key: null,
    id,
    source: String(source),
    kind: String(kind),
    label: String(label || `${source} ${kind}`),
    status: String(status),
    progress: {
      ...progress,
      ...(step ? { step: String(step) } : {}),
      ...(percent !== null ? { percent } : {}),
      ...(stepId !== null ? { stepId } : {}),
      ...(stepIndex !== null ? { stepIndex } : {}),
      ...(stepTotal !== null ? { stepTotal } : {}),
    },
    plan: planSteps ? { steps: planSteps } : null,
    poll: normalizePoll(activity.poll ?? fallback.poll),
    startedAt: activity.startedAt ?? fallback.startedAt ?? null,
    updatedAt: activity.updatedAt ?? new Date().toISOString(),
    error: activity.error ?? null,
    terminal: Boolean(activity.terminal ?? terminalStatus(status)),
  };
  normalized.key = activityKey(normalized);
  return normalized;
}

function productionActivityFromPayload(payload) {
  const progress = payload?.progress;
  const job = payload?.job;
  const jobId = payload?.jobId ?? job?.jobId;
  if (!progress && !job && !jobId) return null;
  const status = job?.status ?? payload?.status ?? progress?.status ?? 'running';
  const percent = Number.isFinite(Number(progress?.percent)) ? Number(progress.percent) : null;
  const sourceCount = Number(progress?.sourceCount);
  const sourceIndex = Number(progress?.sourceIndex);
  const sourceDoneCount = Number(progress?.sourceDoneCount);
  const fileProgress = Number.isFinite(sourceCount) && sourceCount > 0
    ? Number.isFinite(sourceIndex)
      ? `file ${Math.min(sourceCount, sourceIndex + 1)}/${sourceCount}`
      : Number.isFinite(sourceDoneCount)
        ? `files ${Math.min(sourceCount, sourceDoneCount)}/${sourceCount}`
        : null
    : null;
  const batchProgress = progress?.batchCount
    ? `batch ${Number(progress.batchIndex ?? 0) + 1}/${progress.batchCount}`
    : null;
  const progressDetail = batchProgress && /^batch\s+\d+\/\d+/i.test(String(progress?.detail ?? ''))
    ? null
    : progress?.detail;
  const step = progress?.phase ?? progress?.currentStep ?? job?.type ?? 'production';
  const detail = [
    step,
    status,
    percent !== null ? `${Math.round(percent)}%` : null,
    fileProgress,
    batchProgress,
    progress?.source ? basename(progress.source) : null,
    progress?.template ? basename(progress.template) : null,
    progress?.deliverable ? basename(progress.deliverable) : null,
    progressDetail,
    progress?.lastEvent ? `last ${progress.lastEvent}` : null,
  ].filter(Boolean).join(' · ');
  return normalizeActivity({
    id: jobId,
    source: 'production',
    kind: job?.type ?? payload?.type ?? progress?.phase ?? progress?.currentStep ?? 'job',
    label: detail ? `Production: ${detail}` : `Production: ${status}`,
    status,
    progress: {
      ...(progress ?? {}),
      ...(percent !== null ? { percent } : {}),
      step,
    },
    poll: jobId ? {
      server: 'production',
      tool: 'production_job_status',
      args: { jobId },
      intervalMs: 2500,
    } : null,
    error: job?.error ?? payload?.error ?? null,
  });
}

export function extractActivity(payload, context = {}) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload._activity) {
    return normalizeActivity(payload._activity, { source: context.server });
  }
  if (context.server === 'production') {
    return productionActivityFromPayload(payload);
  }
  return null;
}

export function rememberActivity(session, activity) {
  const normalized = normalizeActivity(activity);
  if (!normalized) return null;
  session.activities ??= {};
  session.activities[normalized.key] = {
    ...(session.activities[normalized.key] ?? {}),
    ...normalized,
  };
  if (normalized.source === 'production') {
    session.productionActivity = {
      jobId: normalized.id,
      status: normalized.status,
      label: normalized.label,
      terminal: normalized.terminal,
      updatedAt: normalized.updatedAt,
    };
  }
  return normalized;
}

export function rememberActivityFromPayload(session, payload, context = {}) {
  const activity = extractActivity(payload, context);
  return rememberActivity(session, activity);
}

export function sessionActivities(session) {
  return Object.values(session.activities ?? {})
    .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')));
}

export function formatActivityLine(activity) {
  if (!activity) return '';
  const percent = Number.isFinite(Number(activity.progress?.percent))
    ? `${Math.round(Number(activity.progress.percent))}%`
    : null;
  const step = activity.progress?.step ?? activity.progress?.phase ?? activity.progress?.currentStep ?? null;
  const parts = [
    activity.label,
    activity.status,
    step && !String(activity.label).includes(String(step)) ? step : null,
    percent && !String(activity.label).includes(percent) ? percent : null,
    activity.error ? `error ${activity.error}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function formatActivitySummary(source, action, resultText) {
  const text = String(resultText ?? '').trim();
  if (!text) return null;
  const payload = parseJsonText(text);
  const activity = extractActivity(payload, { server: source, tool: action });
  if (activity) return formatActivityLine(activity);
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

export function activitySnapshot(session) {
  return new Set(sessionActivities(session).map((a) => a.key));
}

export function newNonTerminalActivities(snapshotBefore, session) {
  return sessionActivities(session).filter((a) => !snapshotBefore.has(a.key) && !a.terminal);
}

export function terminalFailures(activities) {
  return activities.filter(
    (a) => a.terminal && ['failed', 'error', 'cancelled', 'canceled'].includes(String(a.status).toLowerCase()),
  );
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
