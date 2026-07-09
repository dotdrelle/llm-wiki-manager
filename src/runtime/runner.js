import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { isCancelledStatus, sessionActivities, terminalFailures } from '../core/activity.js';
import { runAgenticLoop, throwIfAborted } from '../core/agentLoop.js';
import { formatPlanStatus, formatPlanStep } from '../core/plan.js';
import { readyPlanTasks, sanitizePlanForExecution } from '../core/planPatch.js';
import { createAssignmentManager } from '../orchestrator/assignmentManager.js';
import { createAttemptManager } from '../orchestrator/attemptManager.js';
import { createBudgetManager, BudgetExceededError } from '../orchestrator/budgetManager.js';
import { createDispatcher } from '../orchestrator/dispatcher.js';
import { assertValidatedFragment } from '../orchestrator/planValidator.js';
import { createResultAggregator } from '../orchestrator/resultAggregator.js';
import { drainActive, resolveSchedulerConcurrency, startReadyTasks } from '../orchestrator/scheduler.js';
import { emitRuntimeLog, pollActivitiesOnce } from './supervisor.js';

const DEFAULT_MAX_REPLANS = 2;

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
  callTool = null,
  dispatcherPollIntervalMs = 250,
} = {}) {
  let currentInput = initialInput ?? input;
  let replansLeft = Math.max(0, Math.floor(Number(maxReplans) || 0));

  while (true) {
    sanitizeSessionPlanForExecution(session, runId);
    const result = shouldUseParallelScheduler(session.headlessPlan)
      ? await runRuntimeParallelPlan(agent, session, input, {
        signal,
        timeoutMs,
        maxTurns,
        runId,
        pollBusy,
        callTool,
        dispatcherPollIntervalMs,
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
      if (!trigger && isCancelledOnlyLoopResult(result)) {
        dispatchAgentEvent(session, createAgentEvent('run_cancelled', {
          origin: 'runtime',
          runId,
          payload: {
            runId,
            cancelled: true,
            message: 'Runtime run cancelled by user.',
          },
        }));
        emitRuntimeLog(session, 'runtime: run ended by user cancellation (no replan)');
        return { ok: false, result, cancelled: true };
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

    const evaluation = session.headlessPlan
      ? await evaluateRuntimeRun(session, input, { runId, signal, evaluate })
      : null;
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
        if (isUndefinedObjectiveEvaluation(evaluation)) {
          dispatchAgentEvent(session, createAgentEvent('assistant_message', {
            origin: 'runtime',
            runId,
            payload: { content: clarificationMessageForEvaluation(evaluation) },
          }));
          dispatchAgentEvent(session, createAgentEvent('run_done', {
            origin: 'runtime',
            runId,
            payload: { runId },
          }));
          return { ok: true, evaluation, clarified: true };
        }
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
  fragment = null,
  assignmentManager = null,
  attemptManager = null,
  dispatcher = null,
  resultAggregator = null,
  budgetManager = null,
  budgets = {},
  callTool = null,
  dispatcherPollIntervalMs = 250,
} = {}) {
  if (fragment != null) assertValidatedFragment(fragment);
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const active = new Map();
  const attempts = attemptManager ?? createAttemptManager();
  const assigner = assignmentManager ?? createAssignmentManager({ session });
  const executor = dispatcher ?? createDispatcher({
    session,
    ...(callTool ? { callTool } : {}),
    pollIntervalMs: dispatcherPollIntervalMs,
  });
  const aggregator = resultAggregator ?? createResultAggregator({ session, runId });
  const budget = budgetManager ?? createBudgetManager({ budgets, runId });
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
  sanitizeSessionPlanForExecution(session, runId);
  ensurePlanProjection(session, runId);
  emitRuntimeLog(session, `scheduler: parallel plan enabled (concurrency ${limit})`);

  try {
    while (true) {
      if (signal?.aborted) {
        await drainActive(active, attempts);
        throwIfAborted(signal, 'Runtime run cancelled.');
      }
      const pending = (session.headlessPlan ?? []).filter((step) => pendingSchedulerStatus(step.status));
      if (pending.length === 0 && active.size === 0) {
        emitRuntimeLog(session, 'scheduler: all plan tasks terminal');
        return failures.length > 0
          ? { ok: false, completed: failedTaskActivities(session), failures }
          : { ok: true };
      }

      const started = startReadyTasks({
        plan: session.headlessPlan,
        active,
        attemptManager: attempts,
        lockManager: attempts,
        budgetManager: budget,
        registry: session.capabilityRegistry ?? null,
        approvals: session.agentProjection?.approvals ?? session.approvals ?? [],
        limit,
        onDuplicateTask: (taskId) => {
          // Two distinct ready tasks resolved to the same id/step — starting
          // both would let plan_step_updated resolve to whichever one the
          // reducer finds first, silently marking the wrong task done. Skip the
          // duplicate rather than risk misattribution; it stays pending and
          // will surface as a stalled plan instead of corrupting sibling state.
          emitRuntimeLog(session, `scheduler: skipping task with duplicate id/step "${taskId}"`);
        },
        onTaskReady: (task) => {
          emitRuntimeLog(session, taskLogPayload('task.ready', task, { runId, detail: 'ready for assignment' }));
        },
        onAttemptCreated: (task, attempt) => {
          emitRuntimeLog(session, taskLogPayload('attempt.created', task, {
            runId,
            attempt,
            detail: 'attempt created',
          }));
          emitRuntimeLog(session, taskLogPayload('lock.acquired', task, {
            runId,
            attempt,
            detail: attempt?.locks?.join(',') || 'no locks',
          }));
        },
        onTaskStarting: (task) => {
          const taskId = planTaskId(task);
          dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
            origin: 'runtime',
            runId,
            taskId,
            payload: { taskId, status: 'running' },
          }));
          emitRuntimeLog(session, taskLogPayload('task.starting', task, { runId, detail: `starting task ${taskId}` }));
        },
        startTask: (task, attempt) => {
          const taskAbort = createTaskAbortSignal(signal);
          const promise = runDispatchedTask(task, {
            session,
            assignmentManager: assigner,
            dispatcher: executor,
            resultAggregator: aggregator,
            signal: taskAbort.signal,
            timeoutMs,
            runId,
            pollBusy,
            attempt,
          });
          return {
            promise,
            controller: taskAbort.controller,
            signal: taskAbort.signal,
            cleanup: taskAbort.cleanup,
          };
        },
      });
      if (started === 0 && active.size === 0) {
        const exceeded = budget.exceeded?.();
        if (exceeded) {
          dispatchAgentEvent(session, createAgentEvent('run_error', {
            origin: 'runtime',
            runId,
            payload: {
              runId,
              message: `Run budget exceeded: ${exceeded.reason}`,
              budget: exceeded,
            },
          }));
          emitRuntimeLog(session, `scheduler: budget exceeded (${exceeded.reason})`);
          return { ok: false, budgetExceeded: true, reason: exceeded.reason, budget: exceeded, completed: sessionActivities(session), failures };
        }
        const reason = pending.every((step) => approvalWaitingStatus(step.status)) ? 'awaiting_approval' : 'no_ready_plan_task';
        emitRuntimeLog(session, `scheduler: stalled (${reason})`);
        return { ok: false, stalled: true, reason, completed: sessionActivities(session), failures };
      }

      const settled = await Promise.race([...active.values()].map((entry) => entry.promise));
      const activeEntry = active.get(settled.taskId);
      active.delete(settled.taskId);
      activeEntry?.cleanup?.();
      if (settled.cancelled) {
        if (signal?.aborted) {
          await drainActive(active, attempts);
          throwIfAborted(signal, 'Runtime run cancelled.');
        }
        continue;
      }
      try {
        budget.recordTaskResult?.(settled.result ?? {});
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          dispatchAgentEvent(session, createAgentEvent('run_error', {
            origin: 'runtime',
            runId,
            payload: {
              runId,
              message: err.message,
              budget: { reason: err.reason, details: err.details },
            },
          }));
          emitRuntimeLog(session, `scheduler: budget exceeded (${err.reason})`);
          return { ok: false, budgetExceeded: true, reason: err.reason, budget: err.details, completed: sessionActivities(session), failures };
        }
        throw err;
      }
      if (!settled.ok) {
        const task = (session.headlessPlan ?? []).find((item) => planTaskId(item) === settled.taskId);
        const retry = attempts.scheduleRetry?.(task, settled, {
          assignment: settled.assignment,
          registry: session.capabilityRegistry ?? null,
          session,
          runId,
        });
        if (retry?.scheduled) {
          emitRuntimeLog(session, `scheduler: retry scheduled for task ${settled.taskId}${retry.newAgentInstanceId ? ` on ${retry.newAgentInstanceId}` : ''}`);
          continue;
        }
        failures.push(settled);
      }
    }
  } finally {
    if (previousIdentity) session._currentRunIdentity = previousIdentity;
    else delete session._currentRunIdentity;
    if (previousPlanUpdate) session._onPlanUpdate = previousPlanUpdate;
    else delete session._onPlanUpdate;
  }
}

function sanitizeSessionPlanForExecution(session, runId = null) {
  if (!session.headlessPlan) return;
  const sanitized = sanitizePlanForExecution(session.headlessPlan);
  if (sanitized.warnings.length === 0) return;
  session.headlessPlan = sanitized.plan;
  dispatchAgentEvent(session, createAgentEvent('runtime_log', {
    origin: 'runtime',
    runId,
    payload: {
      message: `plan warning: ${sanitized.warnings.join('; ')}`,
    },
  }));
}

function abortCancelledActiveTasks(session, active) {
  for (const [taskId, entry] of active.entries()) {
    const current = (session.headlessPlan ?? []).find((step) => planTaskId(step) === taskId);
    if (current?.status === 'cancelled' && !entry.signal?.aborted) {
      entry.controller?.abort();
    }
  }
}

function pendingSchedulerStatus(status) {
  return ['pending', 'pending_approval', 'waiting_approval'].includes(String(status ?? ''));
}

function approvalWaitingStatus(status) {
  return ['pending_approval', 'waiting_approval'].includes(String(status ?? ''));
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

async function runDispatchedTask(task, {
  session,
  assignmentManager,
  dispatcher,
  resultAggregator,
  signal,
  timeoutMs,
  runId,
  pollBusy,
  attempt,
}) {
  const taskId = planTaskId(task);
  let assignment = null;
  try {
    emitRuntimeLog(session, taskLogPayload('capability.resolving', task, {
      runId,
      attempt,
      detail: `resolving ${task.requiredCapability}`,
    }));
    assignment = await assignmentManager.assign(task, {
      session,
      signal,
    });
    emitRuntimeLog(session, taskLogPayload('agent.selected', task, {
      runId,
      attempt,
      assignment,
      detail: assignment.agentInstanceId,
    }));
    dispatchAgentEvent(session, createAgentEvent('task.assigned', {
      origin: 'assignment_manager',
      runId,
      taskId,
      payload: {
        runId,
        taskId,
        attemptId: attempt?.attemptId ?? null,
        assignment: {
          ...assignment,
          attemptId: attempt?.attemptId ?? null,
          agent: undefined,
        },
      },
    }));
    emitRuntimeLog(session, taskLogPayload('task.assigned', task, {
      runId,
      attempt,
      assignment,
      detail: 'assignment created',
    }));
    const result = await dispatcher.execute(task, assignment, {
      session,
      signal,
      timeoutMs,
      runId,
      pollBusy,
      attempt,
    });
    const aggregate = await resultAggregator.accept(result, { task, assignment });
    if (!aggregate.ok) {
      emitRuntimeLog(session, taskLogPayload('task.failed', task, {
        runId,
        attempt,
        assignment,
        jobId: result?.jobId,
        error: result?.error?.code ?? result?.error?.message ?? result?.status ?? 'failed',
        detail: 'task terminal',
      }));
      return { ok: false, taskId, result, assignment };
    }
    emitRuntimeLog(session, taskLogPayload('task.completed', task, {
      runId,
      attempt,
      assignment,
      jobId: result?.jobId,
      outputs: result?.outputRefs ?? [],
      detail: 'returned to donna',
    }));
    return { ok: true, taskId, result, assignment };
  } catch (err) {
    if (err?.name === 'AbortError') {
      attempt?.release?.();
      dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
        origin: 'runtime',
        runId,
        taskId,
        payload: { taskId, status: 'cancelled' },
      }));
      return { ok: false, taskId, cancelled: true, assignment };
    }
    attempt?.release?.();
    const result = {
      ok: false,
      taskId,
      attemptId: attempt?.attemptId ?? null,
      status: 'failed',
      outputRefs: [],
      metrics: {},
      error: {
        code: 'dispatcher_error',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      },
    };
    await resultAggregator.accept(result, { task, assignment });
    dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
      origin: 'runtime',
      runId,
      taskId,
      payload: { taskId, status: 'failed' },
    }));
    return {
      ok: false,
      taskId,
      result,
      assignment,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function shouldUseParallelScheduler(plan) {
  return readyPlanTasks(plan).some((task) => task.requiredCapability && task.operation);
}

function taskLogPayload(event, task, {
  runId = null,
  attempt = null,
  assignment = null,
  jobId = null,
  outputs = null,
  error = null,
  detail = null,
} = {}) {
  return {
    event,
    runId,
    planRevision: task?.planRevision ?? null,
    groupId: task?.groupId ?? null,
    taskId: planTaskId(task),
    attemptId: attempt?.attemptId ?? null,
    agentType: assignment?.agent?.description?.agentType ?? assignment?.description?.agentType ?? null,
    agentInstanceId: assignment?.agentInstanceId ?? null,
    agentId: assignment?.agentId ?? null,
    jobId,
    capability: task?.requiredCapability ?? assignment?.capability ?? null,
    operation: task?.operation ?? assignment?.operation ?? null,
    outputs,
    error,
    detail,
  };
}

function planTaskId(task) {
  return String(task.id ?? task.step);
}

export async function finishRuntimeRun(session, input, {
  runId,
  signal = null,
  evaluate = true,
} = {}) {
  const evaluation = session.headlessPlan
    ? await evaluateRuntimeRun(session, input, { runId, signal, evaluate })
    : null;
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
      if (isUndefinedObjectiveEvaluation(evaluation)) {
        dispatchAgentEvent(session, createAgentEvent('assistant_message', {
          origin: 'runtime',
          runId,
          payload: { content: clarificationMessageForEvaluation(evaluation) },
        }));
        dispatchAgentEvent(session, createAgentEvent('run_done', {
          origin: 'runtime',
          runId,
          payload: { runId },
        }));
        return { ok: true, evaluation, clarified: true };
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

function isUndefinedObjectiveEvaluation(evaluation) {
  const text = `${evaluation?.reason ?? ''} ${evaluation?.suggestedAction ?? ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /\b(vague|undefined|indefini|unclear|clarif|ambiguous|missing objective|no objective)\b/.test(text);
}

function clarificationMessageForEvaluation(evaluation) {
  const reason = String(evaluation?.reason ?? '').trim();
  return reason
    ? `Je dois clarifier la demande avant d'agir : ${reason}`
    : "Je dois clarifier la demande avant d'agir.";
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
        'Each step MUST be a plain string, not an object.',
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
    // Every replan requires approval: deciding "is this step mutating?" with
    // a verb regex was a safety judgement made by pattern-matching — a
    // missed verb silently skipped the approval gate. Replans are rare
    // (technical failures only) and re-executing work deserves a human OK.
    session._runApprovalRequired = true;
    session._runApprovalResolved = false;
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
  const technical = failures.filter((failure) => !isCancelledStatus(failure.status));
  const cancelled = failures.filter((failure) => isCancelledStatus(failure.status));
  if (cancelled.length > 0 && technical.length === 0 && (result.failures ?? []).every(isCancelledTaskFailure)) {
    return null;
  }
  const failure = technical[0];
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
  const taskFailure = (result.failures ?? []).find((failure) => !isCancelledTaskFailure(failure));
  if (!taskFailure) return null;
  return {
    kind: 'task_error',
    reason: `Task ${taskFailure.taskId} failed${taskFailure.error ? `: ${taskFailure.error}` : ''}`,
    suggestedAction: taskFailure.error ?? null,
    activity: null,
  };
}

function isCancelledTaskFailure(failure) {
  return failure?.cancelled === true
    || failure?.result?.cancelled === true
    || isCancelledStatus(failure?.status)
    || isCancelledStatus(failure?.result?.status);
}

function isCancelledOnlyLoopResult(result) {
  const failures = terminalFailures(result.completed ?? []);
  const technicalActivities = failures.filter((failure) => !isCancelledStatus(failure.status));
  const cancelledActivities = failures.filter((failure) => isCancelledStatus(failure.status));
  const taskFailures = result.failures ?? [];
  const technicalTasks = taskFailures.filter((failure) => !isCancelledTaskFailure(failure));
  const cancelledTasks = taskFailures.filter(isCancelledTaskFailure);
  return technicalActivities.length === 0
    && technicalTasks.length === 0
    && (cancelledActivities.length > 0 || cancelledTasks.length > 0);
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
    .map((step) => formatPlanStep(step).trim())
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
