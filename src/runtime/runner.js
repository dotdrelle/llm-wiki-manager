import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { activityKey, sessionActivities, terminalFailures } from '../core/activity.js';
import { runAgenticLoop, throwIfAborted } from '../core/agentLoop.js';
import { formatPlanStatus } from '../core/plan.js';
import { formatReadyTaskPrompt, readyPlanTasks } from '../core/planPatch.js';
import { emitRuntimeLog, pollActivitiesOnce } from './supervisor.js';

const DEFAULT_MAX_REPLANS = 2;
const DEFAULT_SCHEDULER_CONCURRENCY = 3;

async function waitForRuntimeActivities(session, startedActivities, { timeoutMs, signal, pollBusy }) {
  const deadline = Date.now() + timeoutMs;
  const trackedKeys = new Set(startedActivities.map((activity) => activity.key));
  emitRuntimeLog(session, `activity-loop: tracking ${trackedKeys.size} activity(s)`);

  let tracked = [];
  while (Date.now() < deadline) {
    throwIfAborted(signal, 'Runtime run cancelled.');
    await pollActivitiesOnce(session, { pollBusy, signal });
    tracked = sessionActivities(session).filter((activity) => trackedKeys.has(activity.key));
    const active = tracked.filter((activity) => !activity.terminal);
    if (active.length === 0) {
      const failures = terminalFailures(tracked);
      if (failures.length > 0) {
        for (const failure of failures) {
          emitRuntimeLog(session, `activity-loop: ${failure.label} -> ${failure.status}${failure.error ? ` (${failure.error})` : ''}`);
        }
        return { ok: false, completed: tracked };
      }
      emitRuntimeLog(session, 'activity-loop: tracked activities terminal');
      return { ok: true, completed: tracked };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }

  emitRuntimeLog(session, 'activity-loop: timeout');
  return { ok: false, timedOut: true, completed: tracked };
}

export async function runRuntimeAgenticLoop(agent, session, initialInput, { signal, timeoutMs, maxTurns, runId, pollBusy, parallelHandoff = false }) {
  return runAgenticLoop(agent, session, initialInput, {
    signal,
    timeoutMs,
    maxTurns,
    runId,
    parallelHandoff,
    abortMessage: 'Runtime run cancelled.',
    waitForActivities: (turnSession, startedActivities, waitOptions) =>
      waitForRuntimeActivities(turnSession, startedActivities, { ...waitOptions, pollBusy }),
    onTurnStart: ({ turn, maxTurns: totalTurns }) => {
      emitRuntimeLog(session, `agentic-loop: turn ${turn}/${totalTurns}`);
    },
    onAssistantMessage: ({ response }) => {
      const lastMessage = session.agentProjection?.conversation?.at(-1);
      if (lastMessage?.role !== 'assistant' || lastMessage.content !== response) {
        dispatchAgentEvent(session, createAgentEvent('assistant_message', {
          origin: 'agent',
          runId,
          payload: { content: response },
        }));
      }
    },
    onPlanExtracted: ({ steps }) => {
      emitRuntimeLog(session, `agentic-loop: plan extracted from text (${steps.length} steps, deprecated fallback)`);
    },
    onComplete: () => {
      emitRuntimeLog(session, 'agentic-loop: no pending activity or plan step');
    },
    onPendingSteps: ({ pendingSteps }) => {
      emitRuntimeLog(session, `agentic-loop: ${pendingSteps.length} pending step(s), continuing`);
    },
    onActivitiesStarted: ({ activities }) => {
      emitRuntimeLog(session, `agentic-loop: ${activities.length} new activity(s), waiting`);
    },
    onMaxTurns: ({ maxTurns: totalTurns }) => {
      emitRuntimeLog(session, `agentic-loop: max turns (${totalTurns}) reached`);
    },
  });
}

export async function runRuntimeAgenticWorkflow(agent, session, input, {
  initialInput = null,
  signal = null,
  timeoutMs,
  maxTurns,
  runId,
  pollBusy,
  evaluate = true,
  maxReplans = resolveMaxReplans(),
} = {}) {
  let currentInput = initialInput ?? input;
  let replansLeft = Math.max(0, Math.floor(Number(maxReplans) || 0));

  while (true) {
    const result = shouldUseParallelScheduler(session.headlessPlan)
      ? await runRuntimeParallelPlan(agent, session, input, {
        signal,
        timeoutMs,
        maxTurns,
        runId,
        pollBusy,
      })
      : await runRuntimeAgenticLoop(agent, session, currentInput, {
        signal,
        timeoutMs,
        maxTurns,
        runId,
        pollBusy,
        parallelHandoff: true,
      });
    if (result.ok && result.handoff) continue;
    if (!result.ok) {
      const trigger = replanTriggerFromLoopResult(result);
      if (trigger && replansLeft > 0) {
        const replanned = await replanRuntimeRun(session, input, trigger, {
          runId,
          signal,
          replansLeft: replansLeft - 1,
        });
        if (replanned.ok) {
          replansLeft -= 1;
          currentInput = buildReplannedRunPrompt(input, trigger, replanned.steps);
          continue;
        }
      }
      dispatchAgentEvent(session, createAgentEvent('run_error', {
        origin: 'runtime',
        runId,
        payload: {
          runId,
          message: runtimeLoopErrorMessage(result),
        },
      }));
      return { ok: false, result };
    }

    const evaluation = await evaluateRuntimeRun(session, input, { runId, signal, evaluate });
    if (evaluation) {
      dispatchAgentEvent(session, createAgentEvent('run_evaluated', {
        origin: 'runtime',
        runId,
        payload: {
          runId,
          ok: evaluation.ok,
          reason: evaluation.reason,
          suggestedAction: evaluation.suggestedAction ?? null,
        },
      }));
      if (!evaluation.ok) {
        if (replansLeft > 0) {
          const trigger = {
            kind: 'evaluation',
            reason: evaluation.reason,
            suggestedAction: evaluation.suggestedAction ?? null,
          };
          const replanned = await replanRuntimeRun(session, input, trigger, {
            runId,
            signal,
            replansLeft: replansLeft - 1,
          });
          if (replanned.ok) {
            replansLeft -= 1;
            currentInput = buildReplannedRunPrompt(input, trigger, replanned.steps);
            continue;
          }
        }
        dispatchAgentEvent(session, createAgentEvent('run_error', {
          origin: 'runtime',
          runId,
          payload: {
            runId,
            message: `Runtime evaluator rejected the run: ${evaluation.reason}`,
            suggestedAction: evaluation.suggestedAction ?? null,
          },
        }));
        return { ok: false, evaluation, evaluationRejected: true };
      }
    }

    dispatchAgentEvent(session, createAgentEvent('run_done', {
      origin: 'runtime',
      runId,
      payload: { runId },
    }));
    return { ok: true, evaluation };
  }
}

export async function runRuntimeParallelPlan(agent, session, input, {
  signal = null,
  timeoutMs,
  maxTurns,
  runId = null,
  pollBusy,
  concurrency = resolveSchedulerConcurrency(),
} = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const active = new Map();
  const locks = new Set();
  const failures = [];
  const previousIdentity = session._currentRunIdentity;
  const previousPlanUpdate = session._onPlanUpdate;
  session._currentRunIdentity = {
    ...(previousIdentity ?? {}),
    runId,
    workspace: session.workspace ?? previousIdentity?.workspace ?? null,
  };
  session._onPlanUpdate = () => {
    previousPlanUpdate?.();
    abortCancelledActiveTasks(session, active);
  };
  ensurePlanProjection(session, runId);
  emitRuntimeLog(session, `scheduler: parallel plan enabled (concurrency ${limit})`);

  try {
    while (true) {
      if (signal?.aborted) {
        await drainActive(active, locks);
        throwIfAborted(signal, 'Runtime run cancelled.');
      }
      const pending = (session.headlessPlan ?? []).filter((step) => step.status === 'pending' || step.status === 'pending_approval');
      if (pending.length === 0 && active.size === 0) {
        emitRuntimeLog(session, 'scheduler: all plan tasks terminal');
        return failures.length > 0
          ? { ok: false, completed: failedTaskActivities(session), failures }
          : { ok: true };
      }

      const started = startReadyTasks(agent, session, input, {
        active,
        locks,
        signal,
        timeoutMs,
        maxTurns,
        runId,
        pollBusy,
        limit,
      });
      if (started === 0 && active.size === 0) {
        const reason = pending.every((step) => step.status === 'pending_approval') ? 'awaiting_approval' : 'no_ready_plan_task';
        emitRuntimeLog(session, `scheduler: stalled (${reason})`);
        return { ok: false, stalled: true, reason, completed: sessionActivities(session), failures };
      }

      const settled = await Promise.race([...active.values()].map((entry) => entry.promise));
      const activeEntry = active.get(settled.taskId);
      active.delete(settled.taskId);
      activeEntry?.cleanup?.();
      for (const lock of settled.locks) locks.delete(lock);
      if (settled.cancelled) {
        if (signal?.aborted) {
          await drainActive(active, locks);
          throwIfAborted(signal, 'Runtime run cancelled.');
        }
        continue;
      }
      if (!settled.ok) failures.push(settled);
    }
  } finally {
    if (previousIdentity) session._currentRunIdentity = previousIdentity;
    else delete session._currentRunIdentity;
    if (previousPlanUpdate) session._onPlanUpdate = previousPlanUpdate;
    else delete session._onPlanUpdate;
  }
}

async function drainActive(active, locks) {
  if (active.size === 0) return;
  const entries = [...active.values()];
  await Promise.all(entries.map((entry) => entry.promise));
  for (const entry of entries) entry.cleanup?.();
  active.clear();
  locks.clear();
}

function abortCancelledActiveTasks(session, active) {
  for (const [taskId, entry] of active.entries()) {
    const current = (session.headlessPlan ?? []).find((step) => planTaskId(step) === taskId);
    if (current?.status === 'cancelled' && !entry.signal?.aborted) {
      entry.controller?.abort();
    }
  }
}

// Scope the evaluator/replanner's view of "completed" activities to the
// tasks that actually failed, instead of every activity the whole run has
// ever recorded — a long-running sibling's stale (or unrelated, already
// resolved) activity must not shadow the real failure.
function failedTaskActivities(session) {
  const failedKeys = new Set(
    (session.headlessPlan ?? [])
      .filter((step) => step.status === 'failed')
      .map((step) => step.ownerActivityKey ?? step.activityKey)
      .filter(Boolean),
  );
  const all = sessionActivities(session);
  return failedKeys.size > 0 ? all.filter((activity) => failedKeys.has(activity.key)) : all;
}

function ensurePlanProjection(session, runId) {
  if (!session.headlessPlan || session.agentProjection?.plan) return;
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'runtime',
    runId,
    payload: {
      steps: session.headlessPlan,
      planRevision: session.planRevision ?? 0,
    },
  }));
}

function startReadyTasks(agent, session, input, {
  active,
  locks,
  signal,
  timeoutMs,
  maxTurns,
  runId,
  pollBusy,
  limit,
}) {
  let started = 0;
  const seenTaskIds = new Set(active.keys());
  for (const task of readyPlanTasks(session.headlessPlan)) {
    if (active.size >= limit) break;
    const taskId = planTaskId(task);
    if (active.has(taskId)) continue;
    if (seenTaskIds.has(taskId)) {
      // Two distinct ready tasks resolved to the same id/step — starting
      // both would let plan_step_updated resolve to whichever one the
      // reducer finds first, silently marking the wrong task done. Skip the
      // duplicate rather than risk misattribution; it stays pending and
      // will surface as a stalled plan instead of corrupting sibling state.
      emitRuntimeLog(session, `scheduler: skipping task with duplicate id/step "${taskId}"`);
      continue;
    }
    seenTaskIds.add(taskId);
    const taskLocks = locksForTask(task);
    if (taskLocks.some((lock) => locks.has(lock))) continue;
    for (const lock of taskLocks) locks.add(lock);
    dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId,
      taskId,
      payload: { taskId, status: 'running' },
    }));
    emitRuntimeLog(session, `scheduler: starting task ${taskId}`);
    const taskAbort = createTaskAbortSignal(signal);
    const promise = runParallelTask(agent, session, input, task, {
      signal: taskAbort.signal,
      timeoutMs,
      maxTurns,
      runId,
      pollBusy,
      locks: taskLocks,
    });
    active.set(taskId, {
      taskId,
      locks: taskLocks,
      promise,
      controller: taskAbort.controller,
      signal: taskAbort.signal,
      cleanup: taskAbort.cleanup,
    });
    started += 1;
  }
  return started;
}

function createTaskAbortSignal(parentSignal) {
  const controller = new AbortController();
  if (!parentSignal) return { controller, signal: controller.signal, cleanup: null };
  if (parentSignal.aborted) {
    controller.abort();
    return { controller, signal: controller.signal, cleanup: null };
  }
  const abort = () => controller.abort();
  parentSignal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    signal: controller.signal,
    cleanup: () => parentSignal.removeEventListener('abort', abort),
  };
}

async function runParallelTask(agent, parentSession, input, task, {
  signal,
  timeoutMs,
  maxTurns,
  runId,
  pollBusy,
  locks,
}) {
  const taskId = planTaskId(task);
  const childSession = createTaskSession(parentSession, task, { runId, taskId });
  try {
    const result = await runRuntimeAgenticLoop(agent, childSession, buildTaskPrompt(input, parentSession.headlessPlan, task), {
      signal,
      timeoutMs,
      maxTurns,
      runId,
      pollBusy,
    });
    if (!result.ok) {
      dispatchAgentEvent(parentSession, createAgentEvent('plan_step_updated', {
        origin: 'runtime',
        runId,
        taskId,
        payload: { taskId, status: 'failed' },
      }));
      return { ok: false, taskId, locks, result };
    }
    if ((parentSession.headlessPlan ?? []).find((step) => planTaskId(step) === taskId)?.status === 'cancelled') {
      return { ok: false, taskId, locks, cancelled: true };
    }
    dispatchAgentEvent(parentSession, createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId,
      taskId,
      payload: { taskId, status: 'done' },
    }));
    emitRuntimeLog(parentSession, `scheduler: task ${taskId} done`);
    return { ok: true, taskId, locks, result };
  } catch (err) {
    if (err?.name === 'AbortError') {
      dispatchAgentEvent(parentSession, createAgentEvent('plan_step_updated', {
        origin: 'runtime',
        runId,
        taskId,
        payload: { taskId, status: 'cancelled' },
      }));
      return { ok: false, taskId, locks, cancelled: true };
    }
    dispatchAgentEvent(parentSession, createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId,
      taskId,
      payload: { taskId, status: 'failed' },
    }));
    return {
      ok: false,
      taskId,
      locks,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function createTaskSession(parent, task, { runId, taskId }) {
  const child = {
    ...parent,
    // Copy (not share) the parent's activities: a child's own diffing needs
    // isolation from mutation, but local guards like productionLockBusy must
    // still see activities already running when this task started.
    activities: { ...parent.activities },
    agentEvents: [],
    agentProjection: null,
    _agentProjectionState: null,
    headlessPlan: null,
    _currentRunIdentity: {
      ...(parent._currentRunIdentity ?? {}),
      runId,
      taskId,
      workspace: parent.workspace ?? parent._currentRunIdentity?.workspace ?? null,
    },
    _onAgentEvent: (event) => {
      if (event.type === 'plan_set') return;
      if (event.type === 'plan_step_updated') {
        // The child always targets its own single task, regardless of what
        // step/id the child's LLM passed to wiki__plan_done — a child has no
        // visibility into the parent's real multi-task numbering.
        dispatchAgentEvent(parent, {
          ...event,
          taskId: taskId,
          runId: event.runId ?? runId,
          payload: { ...event.payload, taskId },
        });
        return;
      }
      if (event.type === 'activity_upserted') {
        stampOwnerActivityKey(parent, taskId, event.payload?.activity);
      }
      dispatchAgentEvent(parent, {
        ...event,
        taskId: event.taskId ?? taskId,
        runId: event.runId ?? runId,
      });
    },
  };
  Object.defineProperty(child, '_runApprovalResolved', {
    get: () => parent._runApprovalResolved,
    set: (value) => { parent._runApprovalResolved = value; },
    enumerable: true,
    configurable: true,
  });
  if (parent._requestApproval) {
    child._requestApproval = (request) => {
      if (request?.scope === 'tool') return parent._requestApproval(request);
      // Run-level approval is one decision for the whole run: concurrent
      // children must join the same in-flight request instead of each
      // minting their own (only one of which /approve could ever resolve).
      parent._pendingRunApproval ??= parent._requestApproval(request)
        .finally(() => { delete parent._pendingRunApproval; });
      return parent._pendingRunApproval;
    };
  }
  // Seed the plan through the real reducer (not a raw property write): the
  // child's own _agentProjectionState knows nothing about this task
  // otherwise, and the very next session-projection event (even a plain
  // runtime_log from onTurnStart) would overwrite headlessPlan back to null
  // via applyAgentProjectionToSession. The _onAgentEvent filter above already
  // keeps this plan_set from being forwarded to the parent.
  dispatchAgentEvent(child, createAgentEvent('plan_set', {
    origin: 'runtime',
    runId,
    taskId,
    payload: { steps: [{ ...task, status: 'running' }] },
  }));
  return child;
}

function stampOwnerActivityKey(parent, taskId, rawActivity) {
  if (!rawActivity) return;
  const entry = (parent.headlessPlan ?? []).find((item) => String(item.id ?? item.step) === taskId);
  if (!entry || entry.ownerActivityKey) return;
  entry.ownerActivityKey = activityKey(rawActivity);
}

function buildTaskPrompt(input, plan, task) {
  return [
    'Original task:',
    input || '(unknown)',
    '',
    `Plan status:\n${formatPlanStatus(plan)}`,
    '',
    formatReadyTaskPrompt(task),
    '',
    'Execute exactly this task as an autonomous child task.',
    'Do not start sibling tasks. Do not modify unrelated plan steps.',
    'If this task cannot complete, report the blocker clearly.',
  ].join('\n');
}

function shouldUseParallelScheduler(plan) {
  return readyPlanTasks(plan).length > 0;
}

function planTaskId(task) {
  return String(task.id ?? task.step);
}

function locksForTask(task) {
  const locks = new Set();
  const explicit = task.locks ?? task.writeLocks ?? null;
  if (Array.isArray(explicit)) {
    for (const lock of explicit) if (lock) locks.add(String(lock));
  } else if (explicit && typeof explicit === 'object') {
    if (explicit.workspaceWrite || explicit.workspace) locks.add('workspace:write');
    for (const value of explicit.deliverableWrites ?? explicit.deliverables ?? []) locks.add(`deliverable:${value}`);
    for (const value of explicit.wikiPageWrites ?? explicit.wikiPages ?? []) locks.add(`wiki-page:${value}`);
  }
  for (const value of task.deliverableWrites ?? []) locks.add(`deliverable:${value}`);
  for (const value of task.wikiPageWrites ?? []) locks.add(`wiki-page:${value}`);
  if (task.workspaceWrite) locks.add('workspace:write');
  return [...locks].sort();
}

export async function finishRuntimeRun(session, input, {
  runId,
  signal = null,
  evaluate = true,
} = {}) {
  const evaluation = await evaluateRuntimeRun(session, input, { runId, signal, evaluate });
  if (evaluation) {
    dispatchAgentEvent(session, createAgentEvent('run_evaluated', {
      origin: 'runtime',
      runId,
      payload: {
        runId,
        ok: evaluation.ok,
        reason: evaluation.reason,
        suggestedAction: evaluation.suggestedAction ?? null,
      },
    }));
    if (!evaluation.ok) {
      dispatchAgentEvent(session, createAgentEvent('run_error', {
        origin: 'runtime',
        runId,
        payload: {
          runId,
          message: `Runtime evaluator rejected the run: ${evaluation.reason}`,
          suggestedAction: evaluation.suggestedAction ?? null,
        },
      }));
      return { ok: false, evaluation, evaluationRejected: true };
    }
  }
  dispatchAgentEvent(session, createAgentEvent('run_done', {
    origin: 'runtime',
    runId,
    payload: { runId },
  }));
  return { ok: true, evaluation };
}

export async function evaluateRuntimeRun(session, input, {
  runId = null,
  signal = null,
  evaluate = true,
} = {}) {
  if (!shouldEvaluate(evaluate)) return null;
  const llm = session.llm;
  if (!llm || typeof llm.completeWithTools !== 'function') {
    return fallbackEvaluation('Evaluator unavailable: no LLM completeWithTools client.');
  }
  try {
    emitRuntimeLog(session, 'runtime: evaluating completed run');
    const result = await llm.completeWithTools({
      system: [
        'You are a strict evaluator for an agentic runtime run.',
        'Inspect whether the original task was accomplished using the final plan and recent conversation.',
        'Return only JSON with this exact shape: {"ok":boolean,"reason":"...","suggestedAction":string|null}.',
        'Use ok=false only when a concrete missing action, failed requirement, or wrong result is visible.',
      ].join('\n'),
      tools: [],
      messages: [{ role: 'user', content: buildEvaluationPrompt(input, session, { runId }) }],
      signal,
    });
    return normalizeEvaluation(parseJsonFenced(result.content, 'evaluator response'));
  } catch (err) {
    return fallbackEvaluation(`Evaluator unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function shouldEvaluate(value) {
  if (value === false) return false;
  const env = String(process.env.WIKI_MANAGER_EVALUATOR ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(env);
}

function buildEvaluationPrompt(input, session, { runId = null } = {}) {
  const recentConversation = formatRecentConversation(session);
  const activities = sessionActivities(session)
    .slice(-12)
    .map((activity) => `- ${activity.label ?? activity.id}: ${activity.status}${activity.error ? ` (${activity.error})` : ''}`)
    .join('\n');
  return [
    runId ? `Run id: ${runId}` : null,
    'Original task:',
    input || '(unknown)',
    '',
    session.headlessPlan ? `Final plan:\n${formatPlanStatus(session.headlessPlan)}` : 'Final plan: none',
    activities ? `Recent activities:\n${activities}` : null,
    recentConversation ? `Recent conversation:\n${recentConversation}` : null,
    '',
    'Return JSON only.',
  ].filter(Boolean).join('\n');
}

function parseJsonFenced(content, label = 'JSON response') {
  const text = String(content ?? '').trim();
  if (!text) throw new Error(`empty ${label}`);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1].trim() : text);
}

function normalizeEvaluation(value) {
  return {
    ok: value?.ok === true,
    reason: String(value?.reason ?? '').trim() || (value?.ok === true ? 'Task completed.' : 'Evaluator rejected the run.'),
    suggestedAction: value?.suggestedAction == null ? null : String(value.suggestedAction),
  };
}

function fallbackEvaluation(reason) {
  return {
    ok: true,
    reason,
    suggestedAction: null,
  };
}

export async function replanRuntimeRun(session, input, trigger, {
  runId = null,
  signal = null,
  replansLeft = 0,
} = {}) {
  const llm = session.llm;
  if (!llm || typeof llm.completeWithTools !== 'function') {
    return { ok: false, reason: 'Replanner unavailable: no LLM completeWithTools client.' };
  }
  try {
    const currentPlan = session.headlessPlan;
    emitRuntimeLog(session, 'runtime: replanning remaining work');
    const result = await llm.completeWithTools({
      system: [
        'You are a replanner for an agentic runtime run.',
        'Given the original objective, current plan, and failure reason, return only the remaining steps required.',
        'Do not include steps that are already done.',
        'Return only JSON with this exact shape: {"steps":["..."]}.',
      ].join('\n'),
      tools: [],
      messages: [{ role: 'user', content: buildReplanPrompt(input, session, trigger) }],
      signal,
    });
    const steps = normalizeReplan(parseJsonFenced(result.content, 'replan response').steps);
    if (steps.length === 0) throw new Error('empty replan');
    const mergedSteps = mergeReplanWithCompleted(currentPlan, steps);
    dispatchAgentEvent(session, createAgentEvent('run_replanned', {
      origin: 'runtime',
      runId,
      payload: {
        runId,
        reason: trigger.reason,
        plan: steps,
        replansLeft,
      },
    }));
    dispatchAgentEvent(session, createAgentEvent('plan_set', {
      origin: 'runtime',
      runId,
      payload: {
        steps: mergedSteps,
      },
    }));
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function replanTriggerFromLoopResult(result) {
  // 'awaiting_approval' is not a dead end — it means to wait for a human
  // decision, not to replan around it.
  if (result.stalled && result.reason !== 'awaiting_approval') {
    return {
      kind: 'plan_stalled',
      reason: `Plan is stalled: ${result.reason ?? 'no ready task'} (pending steps exist but none have their dependencies satisfied).`,
      suggestedAction: 'Drop or replace the unsatisfiable dependency.',
      activity: null,
    };
  }
  const failures = terminalFailures(result.completed ?? []);
  const failure = failures[0];
  if (failure) {
    return {
      kind: 'activity_error',
      reason: `${failure.label ?? failure.id ?? 'Activity'} ended with ${failure.status}${failure.error ? `: ${failure.error}` : ''}`,
      suggestedAction: failure.error ?? null,
      activity: failure,
    };
  }
  // The parallel scheduler can fail a task before it ever produces an
  // _activity (e.g. a thrown error on the first turn) — that failure lives
  // in result.failures, not in any activity, so it must be checked too.
  const taskFailure = (result.failures ?? [])[0];
  if (!taskFailure) return null;
  return {
    kind: 'task_error',
    reason: `Task ${taskFailure.taskId} failed${taskFailure.error ? `: ${taskFailure.error}` : ''}`,
    suggestedAction: taskFailure.error ?? null,
    activity: null,
  };
}

function runtimeLoopErrorMessage(result) {
  if (result.timedOut) return 'Runtime agentic loop timed out.';
  if (result.maxTurns) return 'Runtime agentic loop reached max turns.';
  const trigger = replanTriggerFromLoopResult(result);
  return trigger?.reason ?? 'Runtime agentic loop failed.';
}

function buildReplanPrompt(input, session, trigger) {
  const recentConversation = formatRecentConversation(session);
  return [
    'Original task:',
    input || '(unknown)',
    '',
    session.headlessPlan ? `Current plan:\n${formatPlanStatus(session.headlessPlan)}` : 'Current plan: none',
    '',
    `Failure source: ${trigger.kind}`,
    `Failure reason: ${trigger.reason}`,
    trigger.suggestedAction ? `Suggested action: ${trigger.suggestedAction}` : null,
    recentConversation ? `Recent conversation:\n${recentConversation}` : null,
    '',
    'Return only the remaining steps still required. Exclude already completed steps.',
  ].filter(Boolean).join('\n');
}

function buildReplannedRunPrompt(input, trigger, steps) {
  return [
    'Continue a replanned runtime run.',
    '',
    'Original task:',
    input || '(unknown)',
    '',
    `Replan reason: ${trigger.reason}`,
    '',
    'New partial plan:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Execute only the first pending replanned step. Do not repeat completed work.',
  ].join('\n');
}

function normalizeReplan(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step) => String(step ?? '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function mergeReplanWithCompleted(plan, steps) {
  const completed = (plan ?? [])
    .filter((step) => step.status === 'done')
    .map((step, index) => ({
      ...step,
      step: index + 1,
      status: 'done',
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
      outputRefs: Array.isArray(step.outputRefs) ? step.outputRefs.map(String) : [],
    }));
  const completedIds = completed.map((step) => String(step.id ?? step.step));
  // Start numbering past any `replan-N` id already present in the incoming
  // plan (e.g. a `done` step from an earlier replan in the same run) so a
  // second/third replan in one run can't mint an id that collides with one
  // already carried over in `completed`.
  const nextReplanIndex = nextReplanIdIndex(plan);
  // The replanner returns a flat, inherently-ordered list of description
  // strings with no independence information — chain each step to the
  // previous one (in addition to the prior completed steps for the first)
  // so replanned work still runs sequentially instead of fanning out
  // through the parallel scheduler now that any ready task triggers it.
  const replanned = steps.map((description, index) => ({
    step: completed.length + index + 1,
    id: `replan-${nextReplanIndex + index}`,
    description,
    status: 'pending',
    dependsOn: index === 0 ? completedIds : [`replan-${nextReplanIndex + index - 1}`],
    executor: null,
    outputRefs: [],
  }));
  return [...completed, ...replanned];
}

function nextReplanIdIndex(plan) {
  const used = (plan ?? [])
    .map((step) => String(step.id ?? ''))
    .filter((id) => id.startsWith('replan-'))
    .map((id) => Number(id.slice('replan-'.length)))
    .filter((n) => Number.isFinite(n));
  return used.length ? Math.max(...used) + 1 : 1;
}

function formatRecentConversation(session, n = 12) {
  const conversation = session.agentProjection?.conversation ?? [];
  return conversation
    .slice(-n)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
}

function resolveMaxReplans(value = process.env.WIKI_MANAGER_REPLANNER_MAX_REPLANS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : DEFAULT_MAX_REPLANS;
}

function resolveSchedulerConcurrency(value = process.env.WIKI_MANAGER_SCHEDULER_CONCURRENCY) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : DEFAULT_SCHEDULER_CONCURRENCY;
}
