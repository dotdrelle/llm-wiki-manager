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
  const deduped = deduplicateActivities(activities);
  // Group lines only cover activities attached to plan tasks. An activity
  // started OUTSIDE the plan (e.g. the agent calls production_start_job
  // directly after a minimal one-step plan) must still be visible: without
  // this, the panel showed a done "production_status" step while the actual
  // ingest ran invisibly at 15%.
  const lines = groups.length > 0
    ? [
      ...groups.map((group) => groupLine(group, activities)),
      ...unattachedActivities(tasks, deduped).map(activityLine),
    ]
    : deduped.map(activityLine);
  return {
    initialSynthesis: initialSynthesisFromState(state, events),
    progress,
    lines,
  };
}

function unattachedActivities(tasks, activities) {
  const attachedKeys = new Set(tasks
    .flatMap((task) => [task.activityKey, task.ownerActivityKey, task._activityKey])
    .filter(Boolean)
    .map(String));
  const taskIds = new Set(tasks.map((task) => String(task.id ?? task.step ?? '')).filter(Boolean));
  return activities.filter((activity) => {
    const keys = [activity.key, activity.id].filter(Boolean).map(String);
    if (keys.some((value) => attachedKeys.has(value))) return false;
    const stepId = String(activity?.progress?.stepId ?? '');
    if (stepId && taskIds.has(stepId)) return false;
    return true;
  });
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
  // Activity polling can advance before the persisted task projection catches
  // up. Treat a live, linked activity as authoritative instead of rendering
  // the whole group as "validation 0%" while a worker visibly runs at 35%.
  const activePair = group.tasks
    .map((task) => ({ task, activity: activityForTask(task, activities) }))
    .find(({ activity }) => activity && !activity.terminal && !DONE.has(statusOf(activity)));
  const activeTask = activePair?.task ?? running[0] ?? null;
  const activeActivity = activePair?.activity
    ?? running.map((task) => activityForTask(task, activities)).find(Boolean);
  const activeAgents = new Set([
    ...running.map((task) => task.agentInstanceId),
    activeTask?.agentInstanceId,
  ].filter(Boolean)).size;
  const activeProgress = Number.isFinite(Number(activeActivity?.progress?.percent))
    ? Number(activeActivity.progress.percent)
    : running.map((task) => Number(task?.progress?.percent)).find(Number.isFinite);
  let icon = '[ ]';
  let status = 'en attente';
  // A group may contain an earlier failure while another independent task is
  // still progressing. Show the live worker as running; surface the group
  // failure once no work remains. Otherwise its business label was rendered
  // red even though that exact task was healthy and advancing.
  if (running.length > 0 || activeActivity) {
    icon = '[...]';
    status = activeProgress != null ? `${Math.round(activeProgress)} %` : `${done}/${total}`;
  } else if (failed) {
    icon = '[!]';
    status = 'error';
  } else if (done === total) {
    icon = '[x]';
    status = 'done';
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
    : activeActivity && activeProgress != null
      ? Math.round(activeProgress)
    : (total > 0 ? Math.round((done / total) * 100) : null);
  const phaseTasks = activeTask
    ? group.tasks.filter((task) => String(task.operation ?? '') === String(activeTask.operation ?? ''))
    : [];
  const taskIndex = activeTask ? phaseTasks.indexOf(activeTask) + 1 : null;
  const taskTotal = phaseTasks.length || null;
  return {
    id: `group:${group.id}`,
    label: `${icon} ${group.label} - ${status}${agents}`,
    status,
    // Preserve the active worker's business progress (source/template/
    // deliverable, phase and detail). ShellUI can then show the same useful
    // information as the direct wiki CLI instead of only "knowledge.update".
    progress: {
      ...(activeActivity?.progress ?? {}),
      done,
      total,
      percent,
      ...(taskIndex ? { taskIndex, taskTotal, taskOperation: activeTask?.operation ?? null } : {}),
    },
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

function activityForTask(task, activities) {
  const taskId = String(task.id ?? task.step ?? '');
  const activityKey = task.activityKey ?? task.ownerActivityKey ?? null;
  return activities.find((activity) =>
    (activityKey && (activity.key === activityKey || activity.id === activityKey))
    || String(activity?.progress?.stepId ?? '') === taskId,
  );
}

function statusOf(task) {
  const value = String(task?.status ?? '').toLowerCase();
  if (['complete', 'completed', 'success', 'succeeded'].includes(value)) return 'done';
  if (value === 'error') return 'failed';
  return value || 'pending';
}
