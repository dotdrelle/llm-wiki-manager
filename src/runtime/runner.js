import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { isCancelledStatus, sessionActivities, terminalFailures } from '../core/activity.js';
import { runAgenticLoop, throwIfAborted } from '../core/agentLoop.js';
import { formatPlanStatus, formatPlanStep } from '../core/plan.js';
import { readyPlanTasks, sanitizePlanForExecution } from '../core/planPatch.js';
import { createAssignmentManager } from '../orchestrator/assignmentManager.js';
import { createAttemptManager } from '../orchestrator/attemptManager.js';
import { createBudgetManager, BudgetExceededError } from '../orchestrator/budgetManager.js';
import { createDispatcher } from '../orchestrator/dispatcher.js';
import { approvalRequestForTask } from '../orchestrator/approvalPolicy.js';
import { PENDING_STATUSES, tasksAwaitingApproval } from '../orchestrator/dependencyResolver.js';
import { assertValidatedFragment } from '../orchestrator/planValidator.js';
import { createResultAggregator } from '../orchestrator/resultAggregator.js';
import { drainActive, resolvePlanConcurrency, startReadyTasks } from '../orchestrator/scheduler.js';
import { emitRuntimeLog, pollActivitiesOnce } from './supervisor.js';

// 0 by default: automatic replans turn evaluator/replanner TEXT into
// executable pseudo-tasks (no capability, no operation) that stall at 0%
// and pile up as replan-1/2/3 ghost work — the same disease as the removed
// text-plan extraction. Failures now end with an honest report; the user
// (or a stronger model) decides what to do next. Re-enable explicitly with
// WIKI_MANAGER_REPLANNER_MAX_REPLANS if desired.
const DEFAULT_MAX_REPLANS = 0;

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

// Last chat exchanges (user/assistant) that preceded this run, so the run's
// LLM knows WHAT was agreed before acting. Long messages are clipped: the
// context is for grounding, not for re-reading novels.
// Env knobs (documented in .env.example): every tunable introduced by the
// grounding/orchestration work is overridable — nothing business-critical
// is frozen in code.
export function conversationSeed(session, currentInput, { limit = 12, maxChars = 2000 } = {}) {
  const conversation = Array.isArray(session.agentProjection?.conversation)
    ? session.agentProjection.conversation
    : [];
  const seed = conversation
    .filter((message) => ['user', 'assistant'].includes(message?.role) && String(message?.content ?? '').trim())
    .slice(-limit)
    .map((message) => ({ role: message.role, content: String(message.content).slice(0, maxChars) }));
  // The run's own triggering user message is appended by the loop itself —
  // drop it from the seed to avoid sending it twice.
  const last = seed.at(-1);
  if (last && last.role === 'user' && last.content === String(currentInput ?? '').slice(0, maxChars)) seed.pop();
  return seed;
}

export async function runRuntimeAgenticLoop(agent, session, initialInput, { signal, timeoutMs, maxTurns, runId, pollBusy, parallelHandoff = false, initialMessages = [] }) {
  return runAgenticLoop(agent, session, initialInput, {
    signal,
    timeoutMs,
    maxTurns,
    runId,
    parallelHandoff,
    initialMessages,
    deterministicTerminalSummary: true,
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
    onActivitiesCompleted: ({ summary }) => {
      emitRuntimeLog(session, `agentic-loop: completed activities:\n${summary}`);
      dispatchAgentEvent(session, createAgentEvent('assistant_message', {
        origin: 'runtime',
        runId,
        payload: { content: summary || 'Action terminée.' },
      }));
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
  dispatcherPollIntervalMs = 2500,
} = {}) {
  let currentInput = initialInput ?? input;
  let replansLeft = Math.max(0, Math.floor(Number(maxReplans) || 0));
  // Computed ONCE at run start: the pre-run chat. Re-computing inside the
  // loop would re-ingest this run's own turns and duplicate them.
  const runConversationSeed = conversationSeed(session, currentInput);

  // The conversational loop path ends with the agent's own natural-language
  // reply; the deterministic parallel scheduler has no agent voice, so only
  // that path gets a synthesized outcome summary (announceRunOutcome).
  let usedParallelScheduler = false;
  while (true) {
    sanitizeSessionPlanForExecution(session, runId);
    usedParallelScheduler = shouldUseParallelScheduler(session.headlessPlan);
    const result = usedParallelScheduler
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
        initialMessages: runConversationSeed,
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
      if (usedParallelScheduler) await announceRunOutcome(session, { runId, ok: false, signal });
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
        if (isAwaitingUserInputEvaluation(evaluation)) {
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
        // Surface the verdict in the CHAT: the work that ran stays done, the
        // user sees why the evaluator was unsatisfied and decides — no
        // self-generated follow-up tasks.
        dispatchAgentEvent(session, createAgentEvent('assistant_message', {
          origin: 'runtime',
          runId,
          payload: {
            content: `Le run est terminé mais l'évaluation le juge incomplet : ${evaluation.reason}`,
          },
        }));
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

    if (usedParallelScheduler) await announceRunOutcome(session, { runId, ok: true, signal });
    dispatchAgentEvent(session, createAgentEvent('run_done', {
      origin: 'runtime',
      runId,
      payload: { runId },
    }));
    return { ok: true, evaluation };
  }
}

// Emit ONE natural-language Donna message summarizing how the run finished,
// instead of the client streaming a per-job line for every task. Uses the
// workspace LLM to phrase it, degrading to a plain templated fact line if the
// LLM is unavailable or errors — the run must never block on this summary.
async function announceRunOutcome(session, { runId, ok, signal = null } = {}) {
  const plan = Array.isArray(session.headlessPlan) ? session.headlessPlan : [];
  if (plan.length === 0) return;
  let failed = 0;
  let cancelled = 0;
  let completed = 0;
  let firstError = null;
  for (const step of plan) {
    const status = String(step?.status ?? '').toLowerCase();
    if (['failed', 'error', 'stalled'].includes(status)) {
      failed += 1;
      firstError ??= String(
        step?.error?.message ?? step?.error?.code ?? step?.error
        ?? step?.result?.error?.message ?? step?.result?.error?.code ?? '',
      ).trim() || null;
    } else if (['cancelled', 'canceled'].includes(status)) {
      cancelled += 1;
    } else if (['done', 'complete', 'completed', 'success', 'succeeded'].includes(status)) {
      completed += 1;
    }
  }
  const total = plan.length;
  const factLine = ok && failed === 0
    ? `Plan terminé avec succès — ${completed}/${total} tâche(s) réussie(s).`
    : `Plan terminé en erreur — ${completed}/${total} tâche(s) réussie(s), ${failed} en erreur${cancelled ? `, ${cancelled} annulée(s)` : ''}.${firstError ? ` Première erreur : ${firstError}.` : ''}`;
  let content = factLine;
  const llm = session.llm;
  if (llm && typeof llm.completeWithTools === 'function') {
    try {
      const result = await llm.completeWithTools({
        system: [
          'You are Donna, an orchestration assistant reporting a run result to the user.',
          'Rephrase the outcome facts in ONE short, natural sentence, in the same language as the facts.',
          'No lists, no headers, no raw job ids — just a concise human summary.',
        ].join('\n'),
        tools: [],
        messages: [{ role: 'user', content: `Run outcome facts:\n${factLine}` }],
        signal,
      });
      const phrased = String(result?.content ?? '').trim();
      if (phrased) content = phrased;
    } catch {
      // Degrade to the templated fact line — never fail the run on the summary.
    }
  }
  dispatchAgentEvent(session, createAgentEvent('assistant_message', {
    origin: 'runtime',
    runId,
    payload: { content },
  }));
}

export async function runRuntimeParallelPlan(agent, session, input, {
  signal = null,
  timeoutMs,
  maxTurns,
  runId = null,
  pollBusy,
  concurrency = null,
  fragment = null,
  assignmentManager = null,
  attemptManager = null,
  dispatcher = null,
  resultAggregator = null,
  budgetManager = null,
  budgets = {},
  callTool = null,
  dispatcherPollIntervalMs = 2500,
} = {}) {
  if (fragment != null) assertValidatedFragment(fragment);
  const agents = session.agentRegistry?.snapshot?.() ?? session.agentRegistrySnapshot ?? [];
  const configuredConcurrency = Number(concurrency) > 0
    ? Number(concurrency)
    : Number(process.env.WIKI_MANAGER_CAPABILITY_CONCURRENCY || process.env.WIKI_MANAGER_SCHEDULER_CONCURRENCY);
  const limit = resolvePlanConcurrency({
    plan: session.headlessPlan ?? [],
    agents,
    configured: configuredConcurrency,
  });
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
  // Interactive approvals do NOT expire: the user has /approve, "valide
  // tout", /cancel and /run kill — an arbitrary timer only created mystery
  // failures. A deadline exists only when explicitly configured (headless
  // runs, CI) via the session or the env escape hatch.
  const configuredApprovalWait = Number(session._approvalTimeoutMs) > 0
    ? Number(session._approvalTimeoutMs)
    : (Number(process.env.WIKI_MANAGER_APPROVAL_TIMEOUT_MS) > 0 ? Number(process.env.WIKI_MANAGER_APPROVAL_TIMEOUT_MS) : null);
  const approvalDeadline = configuredApprovalWait ? Date.now() + configuredApprovalWait : Infinity;

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
          const executableTask = materializeTaskInputs(task, session.headlessPlan ?? []);
          const taskAbort = createTaskAbortSignal(signal);
          const promise = runDispatchedTask(executableTask, {
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
        // Only wait for a human when approval is the sole remaining blocker.
        // A task whose dependency failed cannot become runnable by approving
        // it; treating it as an approval wait leaves the run alive forever.
        const approvalContext = {
          runId,
          workspace: session.workspace ?? null,
          planRevision: session.planRevision ?? session.agentProjection?.planRevision ?? null,
          tasks: session.headlessPlan ?? [],
        };
        // One snapshot of the approvals list, reused for both the
        // awaiting-approval computation and the per-task dedup below so the two
        // can never diverge mid-iteration.
        const approvals = session.agentProjection?.approvals ?? session.approvals ?? [];
        const needingApproval = tasksAwaitingApproval(approvalContext, { approvals });
        if (needingApproval.length > 0) {
          // The plan is only blocked on a HUMAN decision — wait for it
          // (bounded) instead of declaring the run stalled. Announce once in
          // the chat: users cannot approve what they never saw asked.
          const newlyRequested = [];
          for (const task of needingApproval) {
            const taskId = String(task.id ?? task.taskId ?? task.step ?? '');
            const alreadyRequested = approvals.some((approval) =>
              approval.status === 'pending_approval'
              && String(approval.taskId ?? approval.itemId ?? '') === taskId
              && Number(approval.planRevision ?? approvalContext.planRevision) === Number(approvalContext.planRevision));
            if (alreadyRequested) continue;
            newlyRequested.push(task);
            const request = approvalRequestForTask(task, {
              runId,
              workspaceId: session.workspace ?? null,
              planRevision: approvalContext.planRevision,
            });
            dispatchAgentEvent(session, createAgentEvent('approval.requested', {
              origin: 'runtime',
              runId,
              taskId: request.taskId,
              workspace: session.workspace ?? null,
              payload: request,
            }));
          }
          if (newlyRequested.length > 0) {
            dispatchAgentEvent(session, createAgentEvent('assistant_message', {
              origin: 'runtime',
              runId,
              payload: {
                content: [
                  `⏸ Approbation requise avant exécution : ${newlyRequested.length} tâche(s) mutante(s) en attente.`,
                  ...newlyRequested.slice(0, 5).map((step) => `  - ${step.description ?? step.id}`),
                  newlyRequested.length > 5 ? `  … et ${newlyRequested.length - 5} autre(s).` : null,
                  'Réponds « valide tout » (ou tape /approve) pour lancer, « annule » pour abandonner.',
                ].filter(Boolean).join('\n'),
              },
            }));
            emitRuntimeLog(session, `scheduler: waiting for approval (${newlyRequested.length} new task(s))`);
          }
          if (Date.now() < approvalDeadline) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
            continue;
          }
          // Configured timeout (headless/CI) reached: say it PLAINLY in the
          // chat and let run_error clean the plan/activities so nothing
          // lingers in the panels.
          emitRuntimeLog(session, 'scheduler: approval wait timed out');
          dispatchAgentEvent(session, createAgentEvent('assistant_message', {
            origin: 'runtime',
            runId,
            payload: {
              content: `⏱ Approbation non reçue dans le délai imparti — run arrêté, ${needingApproval.length} tâche(s) annulée(s). Relance la demande quand tu veux.`,
            },
          }));
          return { ok: false, stalled: true, reason: 'awaiting_approval', completed: sessionActivities(session), failures };
        }
        // Any genuine approval-only block returned above. Remaining tasks are
        // unschedulable for another reason (most commonly a failed dependency).
        const reason = 'no_ready_plan_task';
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

export function materializeTaskInputs(task, plan = []) {
  const dependencies = new Set(Array.isArray(task?.dependsOn) ? task.dependsOn.map(String) : []);
  const replacements = new Map();
  for (const dependency of plan ?? []) {
    if (!dependencies.has(String(dependency?.id ?? dependency?.step))) continue;
    const expected = Array.isArray(dependency?.expectedOutputRefs) ? dependency.expectedOutputRefs : [];
    const actual = Array.isArray(dependency?.outputRefs) ? dependency.outputRefs : [];
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      const expectedRef = refValue(expected[index]);
      const actualRef = refValue(actual[index]);
      if (expectedRef && actualRef && expectedRef !== actualRef) replacements.set(expectedRef, actualRef);
    }
  }
  if (replacements.size === 0) return task;
  return {
    ...task,
    arguments: replaceRefValues(task?.arguments, replacements),
    inputRefs: replaceRefValues(task?.inputRefs, replacements),
  };
}

function replaceRefValues(value, replacements) {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceRefValues(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRefValues(item, replacements)]));
  }
  return value;
}

function refValue(value) {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' ? String(value.ref ?? '') : '';
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
  return PENDING_STATUSES.has(String(status ?? ''));
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

// Identity of a plan as displayed: the ordered list of task ids. Two plans
// with the same tasks in the same order are the same plan for projection
// purposes (statuses update through plan_step_updated, not a re-projection).
function planIdentitySignature(plan) {
  return Array.isArray(plan) ? plan.map(planTaskId).join('|') : '';
}

export function ensurePlanProjection(session, runId) {
  if (!session.headlessPlan) return;
  // Re-emit plan_set not only when the projection has no plan yet, but also
  // when the session plan has CHANGED shape since the last projection. A
  // chained run (e.g. /skill pipeline) sets a fresh headlessPlan for step 2
  // while the projection still holds step 1's plan; the old guard
  // (`agentProjection?.plan` truthy → skip) then left the UI stuck on the
  // step 1 plan. Compare task identities and re-project when they differ.
  const projected = session.agentProjection?.plan ?? null;
  if (projected && planIdentitySignature(projected) === planIdentitySignature(session.headlessPlan)) {
    return;
  }
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
        retryable: transientRuntimeError(err),
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

export function shouldUseParallelScheduler(plan) {
  // A validated provider plan enters the scheduler even while every task is
  // waiting for approval. Looking only at readyPlanTasks() made an all-
  // approval plan fall through to the conversational Donna loop; that loop
  // then ignored the integrated TaskGraph and marked the run done.
  return (plan ?? []).some((task) =>
    task?.requiredCapability
    && task?.operation
    && pendingSchedulerStatus(task.status),
  );
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
      if (isAwaitingUserInputEvaluation(evaluation)) {
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
  const structured = structuredPlanEvaluation(session.headlessPlan);
  if (structured) {
    emitRuntimeLog(session, 'runtime: evaluating completed structured plan');
    return structured;
  }
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
        'Return only JSON with this exact shape: {"ok":boolean,"awaitingUserInput":boolean,"reason":"...","suggestedAction":string|null}.',
        'Use ok=false only when a concrete missing action, failed requirement, or wrong result is visible.',
        'Set awaitingUserInput=true when the run correctly stopped to obtain information or a decision only the user can provide (e.g. credentials, choosing between options, an explicit confirmation) — this is expected behaviour, NOT a failure or a missing action. In that case still set ok=false, put the pending question in reason, and do not treat the unasked configuration as a failed requirement.',
        'Otherwise set awaitingUserInput=false.',
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

function structuredPlanEvaluation(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  // Only provider TaskGraph tasks are authoritative. Legacy conversational
  // plans contain prose/tool labels and still use the compatibility evaluator.
  if (!plan.every((step) => step?.requiredCapability && step?.operation)) return null;
  const statuses = plan.map((step) => String(step?.status ?? '').toLowerCase());
  const failed = plan.filter((step) => ['failed', 'error', 'cancelled', 'canceled', 'stalled'].includes(String(step?.status ?? '').toLowerCase()));
  const incomplete = plan.filter((step) => !['done', 'complete', 'completed', 'success', 'succeeded'].includes(String(step?.status ?? '').toLowerCase()));
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `${failed.length} tâche(s) du plan ont échoué : ${failed.map((step) => step.label ?? step.description ?? step.id ?? step.step).join(', ')}.`,
      suggestedAction: null,
    };
  }
  if (incomplete.length > 0) {
    return {
      ok: false,
      reason: `${incomplete.length} tâche(s) du plan ne sont pas terminées.`,
      suggestedAction: null,
    };
  }
  return {
    ok: statuses.length > 0,
    reason: `${statuses.length} tâche(s) du plan terminées avec succès.`,
    suggestedAction: null,
  };
}

function transientRuntimeError(error) {
  const value = error instanceof Error ? error.message : String(error ?? '');
  return /(?:429|timeout|temporar|throttl|rate.?limit|quota|busy|unavailable)/i.test(value);
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
    awaitingUserInput: value?.awaitingUserInput === true,
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

// A run that correctly hands back to the user for required input/decision is
// NOT a failed run \u2014 it is the expected end of an interactive turn. Treat it
// like the undefined-objective case: surface the pending question in chat and
// close the run cleanly (ok, run_done), never replan or emit run_error. The
// explicit evaluator field is authoritative; the keyword fallback covers models
// that answer in prose without emitting the flag.
function isAwaitingUserInputEvaluation(evaluation) {
  if (evaluation?.awaitingUserInput === true) return true;
  if (isUndefinedObjectiveEvaluation(evaluation)) return true;
  const text = `${evaluation?.reason ?? ''} ${evaluation?.suggestedAction ?? ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /\b(awaiting user|await user|user input|user decision|user confirmation|needs? (?:the )?user|requires? (?:the )?user|what to modify|which .* (?:to|should)|ask(?:ed|ing)? the user|attend .* utilisateur|demande .* utilisateur)\b/.test(text);
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

function isBusyFailure(failure) {
  const fields = [
    failure?.error,
    failure?.status,
    failure?.result?.error?.code,
    failure?.result?.error?.message,
    failure?.result?.status,
  ].map((value) => String(value ?? '').toLowerCase());
  return fields.some((value) => value.includes('busy') || value.includes('locked'));
}

function replanTriggerFromLoopResult(result) {
  // 'awaiting_approval' is not a dead end — it means to wait for a human
  // decision, not to replan around it.
  if (result.stalled && result.reason !== 'awaiting_approval') {
    // A stall caused only by transient lock contention (target_busy /
    // workspace_busy) must NOT be replanned: the plan is correct, the
    // workspace was momentarily locked. Replanning around it re-runs the same
    // tasks, hits the lock again and spins the run into a zombie. Fail cleanly
    // so the run finalizes instead of lingering 'running'.
    const blocking = [...(result.failures ?? []), ...terminalFailures(result.completed ?? [])];
    if (blocking.length > 0 && blocking.every(isBusyFailure)) {
      return null;
    }
    return {
      kind: 'plan_stalled',
      reason: `Plan is stalled: ${result.reason ?? 'no ready task'} (pending steps exist but none have their dependencies satisfied).`,
      suggestedAction: 'Drop or replace the unsatisfiable dependency.',
      activity: null,
    };
  }
  const failures = terminalFailures(result.completed ?? []);
  const technical = failures.filter((failure) => !isCancelledStatus(failure.status) && !isBusyFailure(failure));
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
  const taskFailure = (result.failures ?? []).find((failure) => !isCancelledTaskFailure(failure) && !isBusyFailure(failure));
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

function resolveMaxReplans(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : DEFAULT_MAX_REPLANS;
}
