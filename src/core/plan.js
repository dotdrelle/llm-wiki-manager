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
  for (const activity of completed) {
    if (!activity.terminal) continue;
    const activityTokens = [activity.source, activity.kind, activity.label]
      .filter(Boolean).join(' ').toLowerCase();
    const isDone = !['failed', 'error', 'cancelled', 'canceled'].includes(String(activity.status).toLowerCase());
    for (const step of plan) {
      if (step.status !== 'pending') continue;
      const stepText = step.description.toLowerCase();
      const hasMatch =
        activityTokens.split(/\s+/).some((t) => t.length > 3 && stepText.includes(t)) ||
        stepText.split(/\s+/).some((t) => t.length > 3 && activityTokens.includes(t));
      if (hasMatch) {
        step.status = isDone ? 'done' : 'failed';
        break;
      }
    }
  }
}

export function formatPlanStatus(plan) {
  return plan
    .map((s) => {
      const icon = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : ' ';
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
