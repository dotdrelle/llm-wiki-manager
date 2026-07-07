import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { readyPlanTasks } from '../core/planPatch.js';
import { isValidatedFragment, validateFragment } from './planValidator.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'canceled', 'error', 'complete', 'completed', 'success']);

export function integrate(runId, fragment, {
  registry,
  budgets = {},
  session = null,
  store = null,
  workspace = null,
  insertBeforeTasks = [],
  insertAfterTasks = [],
  now = () => new Date(),
} = {}) {
  if (!runId) throw new Error('integrate requires runId.');
  const received = emitPlanEvent('plan.received', { runId, session, store, workspace, now, payload: { runId, fragment } });
  const validation = isValidatedFragment(fragment)
    ? { ok: true, errors: [], normalizedFragment: fragment }
    : validateFragment(fragment, { registry, run: { plannerAgentInstanceId: fragment?.agentInstanceId }, budgets });

  if (!validation.ok) {
    emitPlanEvent('plan.rejected', {
      runId,
      session,
      store,
      workspace,
      now,
      payload: { runId, receivedEventId: received.id, errors: validation.errors },
    });
    return { ok: false, errors: validation.errors, planRevision: currentRevision(session), readyTasks: [] };
  }

  const normalizedFragment = validation.normalizedFragment;
  const currentPlan = clonePlan(session?.headlessPlan ?? session?.agentProjection?.plan ?? []);
  const current = new Map(currentPlan.map((task) => [String(task.id ?? task.step), task]));
  const beforeIds = stringifyList(insertBeforeTasks);
  const afterIds = stringifyList(insertAfterTasks);
  const terminalViolation = firstTerminalMutation(current, beforeIds, afterIds);
  if (terminalViolation) {
    const errors = [{ code: 'terminal_task_mutation', message: `Cannot modify terminal task: ${terminalViolation}`, details: { taskId: terminalViolation } }];
    emitPlanEvent('plan.rejected', {
      runId,
      session,
      store,
      workspace,
      now,
      payload: { runId, receivedEventId: received.id, errors },
    });
    return { ok: false, errors, planRevision: currentRevision(session), readyTasks: [] };
  }

  const globalized = globalizeFragment(runId, normalizedFragment, current);
  const integrated = mergePlan(currentPlan, globalized.tasks, { insertBeforeTasks: beforeIds, insertAfterTasks: afterIds });
  const planRevision = currentRevision(session) + 1;

  emitPlanEvent('plan.validated', {
    runId,
    session,
    store,
    workspace,
    now,
    payload: { runId, receivedEventId: received.id, fragment: normalizedFragment },
  });
  for (const group of globalized.groups) {
    emitPlanEvent('task_group.created', {
      runId,
      session,
      store,
      workspace,
      now,
      payload: { runId, group },
    });
  }
  for (const task of integrated.createdTasks) {
    emitPlanEvent('task.created', {
      runId,
      taskId: task.id,
      session,
      store,
      workspace,
      now,
      payload: { runId, task },
    });
  }
  emitPlanEvent('plan.revision_changed', {
    runId,
    session,
    store,
    workspace,
    now,
    payload: {
      runId,
      planRevision,
      previousRevision: planRevision - 1,
      taskIds: integrated.plan.map((task) => task.id),
      tasks: integrated.plan,
    },
  });

  const readyTasks = readyPlanTasks(integrated.plan);
  return {
    ok: true,
    errors: [],
    normalizedFragment,
    planRevision,
    plan: integrated.plan,
    createdTasks: integrated.createdTasks,
    readyTasks,
  };
}

function emitPlanEvent(type, { runId, taskId = null, session, store, workspace, now, payload }) {
  const event = createAgentEvent(type, {
    origin: 'plan_integrator',
    runId,
    taskId,
    workspace,
    payload,
  });
  event.ts = now().toISOString();
  const dispatched = session ? dispatchAgentEvent(session, event) : event;
  store?.persistEvent?.(dispatched);
  return dispatched;
}

function globalizeFragment(runId, fragment, current) {
  const usedIds = new Set([
    ...current.keys(),
    ...[...current.values()].map((task) => task.groupId).filter(Boolean),
  ]);
  const idMap = new Map();
  const groups = fragment.groups.map((group) => {
    const globalId = uniqueGlobalId(runId, group.id, usedIds);
    idMap.set(group.id, globalId);
    return { ...group, id: globalId, localId: group.id };
  });
  const tasks = fragment.tasks.map((task) => {
    const globalId = uniqueGlobalId(runId, task.id, usedIds);
    idMap.set(task.id, globalId);
    return {
      ...task,
      id: globalId,
      localId: task.id,
      description: task.description ?? task.label,
      status: task.status ?? 'pending',
    };
  });
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.map((dep) => idMap.get(dep) ?? dep);
    if (task.groupId != null) task.groupId = idMap.get(task.groupId) ?? task.groupId;
    if (task.dependsOnGroup != null) task.dependsOnGroup = idMap.get(task.dependsOnGroup) ?? task.dependsOnGroup;
  }
  return { groups, tasks };
}

function mergePlan(currentPlan, newTasks, { insertBeforeTasks, insertAfterTasks }) {
  const plan = clonePlan(currentPlan);
  const createdTasks = clonePlan(newTasks);
  const newTaskIds = new Set(createdTasks.map((task) => task.id));
  const roots = createdTasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
  const leaves = createdTasks
    .filter((task) => !createdTasks.some((candidate) => candidate.dependsOn.includes(task.id)))
    .map((task) => task.id);

  if (insertBeforeTasks.length > 0) {
    const beforeSet = new Set(insertBeforeTasks);
    for (const target of plan.filter((task) => beforeSet.has(task.id))) {
      const previousDeps = [...(target.dependsOn ?? [])];
      for (const task of createdTasks) {
        if (roots.includes(task.id)) task.dependsOn = uniqueStrings([...task.dependsOn, ...previousDeps]);
      }
      target.dependsOn = uniqueStrings([...leaves]);
    }
  }

  if (insertAfterTasks.length > 0) {
    const afterSet = new Set(insertAfterTasks);
    for (const task of createdTasks) {
      if (roots.includes(task.id)) task.dependsOn = uniqueStrings([...task.dependsOn, ...afterSet]);
    }
    for (const existing of plan) {
      if (!Array.isArray(existing.dependsOn)) existing.dependsOn = [];
      const touched = existing.dependsOn.some((dep) => afterSet.has(dep));
      if (!touched || newTaskIds.has(existing.id)) continue;
      existing.dependsOn = uniqueStrings(existing.dependsOn.flatMap((dep) => (afterSet.has(dep) ? leaves : [dep])));
    }
  }

  const next = [...plan, ...createdTasks].map((task, index) => ({
    ...task,
    step: index + 1,
    dependsOn: uniqueStrings(task.dependsOn ?? []),
  }));
  return { plan: next, createdTasks };
}

function firstTerminalMutation(current, beforeIds, afterIds) {
  for (const id of beforeIds) {
    if (isTerminal(current.get(id))) return id;
  }
  for (const id of afterIds) {
    const dependents = [...current.values()].filter((task) => (task.dependsOn ?? []).includes(id));
    const terminal = dependents.find(isTerminal);
    if (terminal) return terminal.id;
  }
  return null;
}

function uniqueGlobalId(runId, localId, usedIds) {
  const base = `${runId}:${localId}`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  usedIds.add(id);
  return id;
}

function currentRevision(session) {
  return Number.isInteger(session?.planRevision) && session.planRevision >= 0 ? session.planRevision : 0;
}

function isTerminal(task) {
  return TERMINAL_STATUSES.has(String(task?.status ?? '').toLowerCase());
}

function stringifyList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map(String).filter(Boolean))];
}

function clonePlan(plan) {
  return Array.isArray(plan) ? plan.map((task) => ({ ...task, dependsOn: [...(task.dependsOn ?? [])] })) : [];
}
