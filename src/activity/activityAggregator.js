import { calculateWeightedProgress } from './progressCalculator.js';
import { deduplicateActivities } from './activityDeduplicator.js';
import { initialSynthesisFromState } from './runSynthesis.js';

const DONE = new Set(['done', 'complete', 'completed', 'success', 'succeeded']);
const ACTIVE = new Set(['running', 'starting', 'queued']);

export function aggregateActivity(state = {}, events = []) {
  const tasks = Array.isArray(state.plan) ? state.plan : [];
  const activities = Array.isArray(state.activities) ? state.activities : [];
  const progress = calculateWeightedProgress(tasks, activities);
  const groups = groupTasks(tasks);
  const lines = groups.length > 0
    ? groups.map((group) => groupLine(group, activities))
    : deduplicateActivities(activities).map(activityLine);
  return {
    initialSynthesis: initialSynthesisFromState(state, events),
    progress,
    lines,
  };
}

function groupTasks(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const id = task.groupId ?? task.dependsOnGroup ?? task.requiredCapability ?? task.id ?? task.step;
    if (!groups.has(id)) groups.set(id, { id, label: groupLabel(task), tasks: [] });
    groups.get(id).tasks.push(task);
  }
  return [...groups.values()];
}

function groupLabel(task) {
  return task.groupLabel
    ?? task.group?.label
    ?? task.requiredCapability
    ?? task.groupId
    ?? task.dependsOnGroup
    ?? task.label
    ?? task.description
    ?? `Task ${task.step ?? ''}`.trim();
}

function groupLine(group, activities) {
  const total = group.tasks.length;
  const done = group.tasks.filter((task) => DONE.has(statusOf(task))).length;
  const running = group.tasks.filter((task) => ACTIVE.has(statusOf(task)));
  const failed = group.tasks.find((task) => statusOf(task) === 'failed');
  const waitingApproval = group.tasks.some((task) => ['pending_approval', 'waiting_approval'].includes(statusOf(task)));
  const activeAgents = new Set(running.map((task) => task.agentInstanceId).filter(Boolean)).size;
  const activeProgress = running
    .map((task) => progressForTask(task, activities))
    .find((value) => value != null);
  let icon = '[ ]';
  let status = 'en attente';
  if (failed) {
    icon = '[!]';
    status = 'error';
  } else if (done === total) {
    icon = '[x]';
    status = 'done';
  } else if (running.length > 0) {
    icon = '[...]';
    status = activeProgress != null ? `${Math.round(activeProgress)} %` : `${done}/${total}`;
  } else if (waitingApproval) {
    icon = '[!]';
    status = 'validation';
  } else if (done > 0) {
    icon = '[...]';
    status = `${done}/${total}`;
  }
  const agents = activeAgents > 0 ? ` - ${activeAgents} agent${activeAgents > 1 ? 's' : ''}` : '';
  // While a task is running, expose ITS live progress as the group percent.
  // The completion ratio (done/total tasks) said 0% while the label showed
  // the real activity progress ("— 1 %"), so the TUI badge contradicted the
  // text. Fall back to the task-completion ratio when nothing is running.
  const percent = running.length > 0 && activeProgress != null
    ? Math.round(activeProgress)
    : (total > 0 ? Math.round((done / total) * 100) : null);
  return {
    id: `group:${group.id}`,
    label: `${icon} ${group.label} - ${status}${agents}`,
    status,
    progress: { done, total, percent },
    activeAgents,
  };
}

function activityLine(activity) {
  const percent = Number(activity?.progress?.percent);
  const progress = Number.isFinite(percent) ? ` - ${Math.round(percent)} %` : '';
  return {
    id: activity.key ?? activity.id ?? activity.label,
    label: `... ${activity.label ?? activity.source ?? 'Activity'}${progress}`,
    status: activity.status ?? 'running',
    progress: activity.progress ?? null,
  };
}

function progressForTask(task, activities) {
  const taskId = String(task.id ?? task.step ?? '');
  const activityKey = task.activityKey ?? task.ownerActivityKey ?? null;
  const match = activities.find((activity) =>
    (activityKey && (activity.key === activityKey || activity.id === activityKey))
    || String(activity?.progress?.stepId ?? '') === taskId,
  );
  const value = Number(match?.progress?.percent ?? task.progress?.percent);
  return Number.isFinite(value) ? value : null;
}

function statusOf(task) {
  const value = String(task?.status ?? '').toLowerCase();
  if (['complete', 'completed', 'success', 'succeeded'].includes(value)) return 'done';
  if (value === 'error') return 'failed';
  return value || 'pending';
}
