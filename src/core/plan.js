export function extractHeadlessPlan(text) {
  const steps = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (m) steps.push({ step: Number(m[1]), description: m[2].trim(), status: 'pending' });
  }
  if (steps.length < 2 || steps[0].step !== 1) return null;
  return steps;
}

export function matchCompletedToPlan(plan, completed) {
  if (!plan) return;
  syncActivitiesToPlan(plan, completed.filter((activity) => activity.terminal));
}

export function syncActivitiesToPlan(plan, activities) {
  if (!plan) return;
  for (const activity of activities ?? []) {
    const step = findMatchingPlanStep(plan, activity);
    if (!step) continue;
    const terminal = Boolean(activity.terminal);
    const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(String(activity.status).toLowerCase());
    if (terminal) {
      step.status = failed ? 'failed' : 'done';
    } else if (!failed) {
      step.status = 'running';
    }
    step.activityKey = activity.key ?? activity.id ?? activity.jobId ?? null;
  }
}

export function formatPlanStatus(plan) {
  return plan
    .map((s) => {
      const icon = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'running' ? '…' : ' ';
      return `${s.step}. [${icon}] ${s.description}`;
    })
    .join('\n');
}

export function formatCompletedActivities(activities) {
  return activities
    .filter((a) => a.terminal)
    .map((a) => `- ${a.source} ${a.id ?? a.kind}: ${a.status}${a.error ? ` (${a.error})` : ''}`)
    .join('\n');
}

function findMatchingPlanStep(plan, activity) {
  const activityTokens = tokenize([
    activity?.source,
    activity?.kind,
    activity?.label,
    activity?.progress?.step,
    activity?.progress?.phase,
    activity?.progress?.currentStep,
    activity?.progress?.template,
    activity?.progress?.deliverable,
  ].filter(Boolean).join(' '));
  if (activityTokens.length === 0) return null;

  const candidates = plan
    .map((step) => ({
      step,
      score: matchScore(tokenize(step.description), activityTokens),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return statusRank(a.step.status) - statusRank(b.step.status);
    });

  return candidates[0]?.step ?? null;
}

function tokenize(value) {
  return [
    ...new Set(
      String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .match(/[a-z0-9-]{4,}/g)
        ?.filter((token) => !['production', 'running', 'queued', 'done', 'failed'].includes(token)) ?? [],
    ),
  ];
}

function matchScore(stepTokens, activityTokens) {
  let score = 0;
  for (const token of stepTokens) {
    if (activityTokens.includes(token)) score += token === 'build' || token === 'polish' || token === 'export' || token === 'ingest' ? 4 : 1;
  }
  return score;
}

function statusRank(status) {
  if (status === 'running') return 0;
  if (status === 'pending') return 1;
  if (status === 'done') return 2;
  return 3;
}
