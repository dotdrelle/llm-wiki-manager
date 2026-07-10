export function ensurePlanFromActivity(session, activity) {
  if (!activity) return;
  const actKey = activity.key ?? null;
  if (session.headlessPlan?.some((step) => step.owner === 'orchestrator')) {
    attachActivityToExistingPlan(session.headlessPlan, activity);
    session._onPlanUpdate?.();
    return;
  }
  // Same activity still being tracked — preserve current plan state (polling update).
  if (session.headlessPlan && actKey !== null && session.headlessPlan[0]?._activityKey === actKey) return;
  const steps = activity.plan?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    session.headlessPlan = steps.map((s, i) => ({
      step: i + 1,
      id: s.id ?? null,
      description: s.label,
      status: 'pending',
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      executor: s.executor ?? null,
      executorQuery: s.executorQuery ?? null,
      outputRefs: Array.isArray(s.outputRefs) ? s.outputRefs.map(String) : [],
      owner: 'activity',
      ownerActivityKey: activity.key,
      _activityKey: activity.key,
    }));
  } else {
    session.headlessPlan = [{
      step: 1,
      id: null,
      description: activity.label,
      status: 'pending',
      owner: 'activity',
      ownerActivityKey: activity.key,
      _activityKey: activity.key,
    }];
  }
  session._onPlanUpdate?.();
}

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
  const contractTaskPlan = isContractTaskPlan(plan);
  for (const activity of activities ?? []) {
    const terminal = Boolean(activity.terminal);
    const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(String(activity.status).toLowerCase());
    const actKey = activity.key ?? activity.id ?? activity.jobId ?? null;
    const structuredMatch = findMatchingPlanStepByStructure(plan, activity);
    const matched = structuredMatch ?? findMatchingPlanStep(plan, activity);
    if (!matched) continue;

    if (terminal && !failed) {
      const ownedSteps = actKey ? plan.filter((s) => s._activityKey === actKey) : [];
      if (contractTaskPlan && structuredMatch && ownedSteps.length === 0) {
        matched.status = 'done';
        matched.activityKey = actKey;
        continue;
      }
      // Structured plan: mark all steps owned by this activity as done.
      // Legacy plan (no _activityKey): mark all steps up to matched as done (sequential assumption).
      if (ownedSteps.length > 0) {
        for (const step of ownedSteps) {
          if (step.status !== 'failed') {
            step.status = 'done';
            step.activityKey = actKey;
          }
        }
      } else {
        for (const step of plan) {
          if (step.status === 'failed') continue;
          if (step.step <= matched.step) {
            step.status = 'done';
            step.activityKey = actKey;
          }
        }
      }
    } else if (terminal && failed) {
      matched.status = 'failed';
      matched.activityKey = actKey;
    } else if (!failed) {
      if (contractTaskPlan && structuredMatch) {
        matched.status = 'running';
        matched.activityKey = actKey;
        continue;
      }
      // Running: matched step is in progress; preceding pending steps are implicitly done.
      for (const step of plan) {
        if (step.status === 'failed') continue;
        if (step.step < matched.step && step.status === 'pending') {
          step.status = 'done';
          step.activityKey = actKey;
        } else if (step.step === matched.step) {
          step.status = 'running';
          step.activityKey = actKey;
        }
      }
    }
  }
}

export function formatPlanStatus(plan) {
  return plan
    .map((s) => {
      const icon = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'running' ? '…' : ' ';
      return `${s.step}. [${icon}] ${formatPlanStep(s)}`;
    })
    .join('\n');
}

export function formatPlanStep(step) {
  if (step == null) return '';
  if (typeof step === 'string') return step;
  if (typeof step !== 'object') return String(step);
  for (const key of ['description', 'label', 'id', 'name']) {
    if (step[key] != null) return formatPlanStep(step[key]);
  }
  return '';
}

export function formatConfigValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(formatConfigValue).join(', ');
  if (typeof value !== 'object') return String(value);
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${formatConfigValue(item)}`)
    .join(', ');
}

export function formatCompletedActivities(activities) {
  const terminal = activities.filter((activity) => activity.terminal);
  const lines = terminal.map((activity) => {
    const label = activity.kind ?? activity.label ?? `${activity.source} ${activity.id ?? 'activity'}`;
    return `- ${label}: ${activity.status}${activity.error ? ` (${activity.error})` : ''}`;
  });
  const outputs = [...new Set(terminal.flatMap((activity) => activity.outputRefs ?? []).map((ref) => {
    if (ref && typeof ref === 'object') return String(ref.ref ?? ref.path ?? ref.url ?? '').trim();
    return String(ref ?? '').trim();
  }).filter(Boolean))];
  if (outputs.length > 0) lines.push(...outputs.map((output) => `- output: ${output}`));
  return lines.join('\n');
}

function findMatchingPlanStepByStructure(plan, activity) {
  const actKey = activity.key ?? null;
  const stepId = activity.progress?.stepId ?? null;
  const stepIndex = activity.progress?.stepIndex ?? null;

  function compatible(step) {
    return !step._activityKey || !actKey || step._activityKey === actKey;
  }

  if (stepId !== null) {
    const found = plan.find((s) => s.id != null && String(s.id) === stepId && compatible(s));
    if (found) return found;
  }
  if (stepIndex !== null && Number.isFinite(Number(stepIndex))) {
    const found = plan.find((s) => s.step === Number(stepIndex) && compatible(s));
    if (found) return found;
  }
  return null;
}

function findMatchingPlanStep(plan, activity) {
  const actKey = activity.key ?? null;
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
    .filter((step) => !step._activityKey || !actKey || step._activityKey === actKey)
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

export function attachActivityToExistingPlan(plan, activity) {
  const actKey = activity.key ?? activity.id ?? activity.jobId ?? null;
  if (!actKey) return;
  const contractTaskPlan = isContractTaskPlan(plan);
  const structuredMatch = findMatchingPlanStepByStructure(plan, activity);
  const matched = structuredMatch
    ?? plan.find((step) => step.activityKey === actKey)
    ?? plan.find((step) => step.ownerActivityKey === actKey)
    ?? plan.find((step) => step.status === 'pending')
    ?? plan.find((step) => step.status === 'running');
  if (!matched) return;
  matched.activityKey = actKey;
  if (!matched.ownerActivityKey) matched.ownerActivityKey = actKey;
  const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(String(activity.status).toLowerCase());
  if (activity.terminal) {
    matched.status = failed ? 'failed' : 'done';
    return;
  }
  if (!failed) {
    if (contractTaskPlan && structuredMatch) {
      matched.status = 'running';
      return;
    }
    for (const step of plan) {
      if (step.status === 'failed') continue;
      if (step.step < matched.step) step.status = 'done';
      else if (step.step === matched.step) step.status = 'running';
    }
  }
}

function isContractTaskPlan(plan) {
  return (plan ?? []).some((step) => step.requiredCapability || step.operation);
}
