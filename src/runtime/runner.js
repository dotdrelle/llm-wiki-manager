import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { sessionActivities, terminalFailures } from '../core/activity.js';
import { runAgenticLoop, throwIfAborted } from '../core/agentLoop.js';
import { formatPlanStatus } from '../core/plan.js';
import { emitRuntimeLog, pollActivitiesOnce } from './supervisor.js';

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
      emitRuntimeLog(session, `agentic-loop: plan extracted from text (${steps.length} steps)`);
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
    return normalizeEvaluation(parseEvaluationJson(result.content));
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
  const conversation = session.agentProjection?.conversation ?? [];
  const recentConversation = conversation
    .slice(-12)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
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

function parseEvaluationJson(content) {
  const text = String(content ?? '').trim();
  if (!text) throw new Error('empty evaluator response');
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
