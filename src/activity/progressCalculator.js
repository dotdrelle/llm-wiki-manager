const TERMINAL_DONE = new Set(['done', 'complete', 'completed', 'success', 'succeeded']);
const TERMINAL_ANY = new Set([...TERMINAL_DONE, 'failed', 'cancelled', 'canceled', 'error']);

export function calculateWeightedProgress(tasks = [], activities = []) {
  const items = Array.isArray(tasks) ? tasks : [];
  if (items.length === 0) return { mode: 'indeterminate', percent: null, done: 0, total: 0 };
  const totalWeight = items.reduce((sum, task) => sum + taskWeight(task), 0) || items.length;
  let completedWeight = 0;
  let done = 0;
  for (const task of items) {
    const weight = taskWeight(task);
    const status = normalizeStatus(task.status);
    if (TERMINAL_DONE.has(status)) {
      completedWeight += weight;
      done += 1;
    } else if (!TERMINAL_ANY.has(status)) {
      completedWeight += weight * taskProgressRatio(task, activities);
    }
  }
  return {
    mode: 'weighted_tasks',
    percent: Math.round((completedWeight / totalWeight) * 100),
    done,
    total: items.length,
    completedWeight,
    totalWeight,
  };
}

export function taskProgressRatio(task, activities = []) {
  const direct = progressPercent(task?.progress);
  if (direct != null) return direct / 100;
  const taskId = String(task?.id ?? task?.step ?? task?.stepId ?? '');
  const activityKey = task?.activityKey ?? task?.ownerActivityKey ?? null;
  const match = (activities ?? []).find((activity) =>
    (activityKey && (activity.key === activityKey || activity.id === activityKey))
    || String(activity?.progress?.stepId ?? '') === taskId
    || String(activity?.raw?.progress?.stepId ?? '') === taskId,
  );
  const activityPercent = progressPercent(match?.progress ?? match?.raw?.progress);
  return activityPercent == null ? 0 : activityPercent / 100;
}

export function progressPercent(progress) {
  const value = Number(progress?.percent);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function taskWeight(task) {
  const value = Number(task?.progressWeight);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizeStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'error') return 'failed';
  if (value === 'canceled') return 'cancelled';
  if (value === 'complete' || value === 'completed' || value === 'success') return 'done';
  return value || 'pending';
}
