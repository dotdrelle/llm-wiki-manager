import { isTerminal, isUnsuccessfulTerminal } from '../orchestrator/taskStatuses.js';
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


export function syncActivitiesToPlan(plan, activities) {
  if (!plan) return;
  const contractTaskPlan = isContractTaskPlan(plan);
  for (const activity of activities ?? []) {
    const terminal = Boolean(activity.terminal);
    const failed = isUnsuccessfulTerminal(activity.status);
    const actKey = activity.key ?? activity.id ?? activity.jobId ?? null;
    const structuredMatch = findMatchingPlanStepByStructure(plan, activity);
    const matched = structuredMatch ?? (contractTaskPlan
      ? plan.find((step) => step.activityKey === actKey || step.ownerActivityKey === actKey)
      : findMatchingPlanStep(plan, activity));
    if (!matched) continue;
    // A terminal scheduler result is authoritative. Historical queued or late
    // activity frames cannot revive it during an adaptive plan revision.
    if (contractTaskPlan && isTerminal(matched.status)) continue;

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

// A TAXO ingest is ONE task over the whole batch, so the per-file "Analyze X"
// steps that used to list the pending inputs no longer exist. The files the
// task works on are read back from its inputRefs/arguments; only the file the
// live progress names is known to be in flight — the others are not reported
// per file and stay pending until the task settles, then take its status.
function currentProgressDocument(activities) {
  for (const item of Array.isArray(activities) ? activities : []) {
    if (item?.terminal || String(item?.status ?? 'running').toLowerCase() !== 'running') continue;
    const progress = item.progress ?? {};
    const text = [progress.label, progress.detail, item.label].filter(Boolean).join(' · ');
    const named = progress.source ?? progress.currentFile ?? progress.file ?? /([^\s·/]+\.md)\b/.exec(text)?.[1];
    if (!named) continue;
    const section = /\bSection \d+\/\d+/i.exec(text)?.[0];
    return [String(named).split('/').pop(), section].filter(Boolean).join(' · ');
  }
  return null;
}

export function planStepInputs(task, activities = [], limit = 40) {
  const raw = task?.raw ?? task ?? {};
  const refs = (Array.isArray(raw.inputRefs) ? raw.inputRefs : [])
    .filter((ref) => !ref?.type || ref.type === 'file')
    .map((ref) => String(typeof ref === 'string' ? ref : ref?.ref ?? ''));
  const inputs = Array.isArray(raw.arguments?.inputs) ? raw.arguments.inputs.map(String) : [];
  const files = [...new Set([...refs, ...inputs].map((value) => value.trim()).filter(Boolean))];
  const status = String(task?.status ?? raw.status ?? 'pending');
  // A task that declares no files (a whole-archive rebuild planned by an older
  // agent, a build…) still says what it is on: the document the live progress
  // names, with its section counter — the same line the Activity panel shows.
  if (files.length === 0) {
    const current = status === 'running' ? currentProgressDocument(activities) : null;
    return current ? [{ name: current, ref: '', status: 'running' }] : [];
  }
  const live = status === 'running'
    ? (Array.isArray(activities) ? activities : [])
      .filter((item) => !item?.terminal && String(item?.status ?? 'running').toLowerCase() === 'running')
      .map((item) => [item.label, item.progress?.label, item.progress?.detail, item.progress?.currentFile, item.progress?.file, item.progress?.source].filter(Boolean).join(' '))
      .join(' | ')
      .toLowerCase()
    : '';
  // Per-file states the production agent reads from the engine trace
  // (basename -> running/done/failed): a TAXO ingest is ONE task, so this is how
  // finished files show done and several in-flight sources show running.
  const reported = new Map();
  if (status === 'running') {
    for (const item of Array.isArray(activities) ? activities : []) {
      const map = item?.progress?.sourceStates;
      if (map && typeof map === 'object') {
        for (const [file, value] of Object.entries(map)) reported.set(String(file).toLowerCase(), String(value));
      }
    }
  }
  const rows = files.slice(0, limit).map((ref) => {
    const name = ref.split('/').pop() || ref;
    const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
    const current = Boolean(live) && (live.includes(name.toLowerCase()) || (stem.length > 3 && live.includes(stem)));
    const known = reported.get(name.toLowerCase());
    return { name, ref, status: status === 'running' ? (known ?? (current ? 'running' : 'pending')) : status };
  });
  if (files.length > limit) rows.push({ name: `+${files.length - limit} more file(s)`, ref: '', status: status === 'running' ? 'pending' : status });
  return rows;
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
    ?? (!contractTaskPlan ? plan.find((step) => step.status === 'pending') ?? plan.find((step) => step.status === 'running') : null);
  if (!matched) return;
  if (contractTaskPlan && isTerminal(matched.status)) return;
  matched.activityKey = actKey;
  if (!matched.ownerActivityKey) matched.ownerActivityKey = actKey;
  const failed = isUnsuccessfulTerminal(activity.status);
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
