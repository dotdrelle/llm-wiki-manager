import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { sessionActivities, terminalFailures } from '../core/activity.js';
import { runAgenticLoop, throwIfAborted } from '../core/agentLoop.js';
import { formatPlanStatus } from '../core/plan.js';
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

export async function runRuntimeAgenticLoop(agent, session, initialInput, { signal, timeoutMs, maxTurns, runId, pollBusy }) {
  return runAgenticLoop(agent, session, initialInput, {
    signal,
    timeoutMs,
    maxTurns,
    runId,
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
    const result = await runRuntimeAgenticLoop(agent, session, currentInput, {
      signal,
      timeoutMs,
      maxTurns,
      runId,
      pollBusy,
    });
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
        steps: steps.map((description, index) => ({
          step: index + 1,
          description,
          status: 'pending',
        })),
      },
    }));
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function replanTriggerFromLoopResult(result) {
  const failures = terminalFailures(result.completed ?? []);
  const failure = failures[0];
  if (!failure) return null;
  return {
    kind: 'activity_error',
    reason: `${failure.label ?? failure.id ?? 'Activity'} ended with ${failure.status}${failure.error ? `: ${failure.error}` : ''}`,
    suggestedAction: failure.error ?? null,
    activity: failure,
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
