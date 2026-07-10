import { buildAgentSystemPrompt, formatLlmUnavailableMessage } from '../agent/graph.js';
import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';
import { activitySnapshot, newNonTerminalActivities } from './activity.js';
import { extractHeadlessPlan, formatCompletedActivities, formatPlanStatus } from './plan.js';
import { formatReadyTaskPrompt, nextReadyPlanTask, readyPlanTasks, sanitizePlanForExecution } from './planPatch.js';

export function abortError(message = 'Agent run cancelled.') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function throwIfAborted(signal, message) {
  if (signal?.aborted) throw abortError(message);
}

export async function runAgentTurn(agent, session, input, {
  messages = [],
  signal = null,
} = {}) {
  let streamedContent = '';
  session._onStream = (delta) => { streamedContent += delta; };
  session._onStreamReset = () => { streamedContent = ''; };
  if (signal) session._abortSignal = signal;
  let result;
  try {
    result = await agent.invoke({ input, session, messages, signal });
  } finally {
    delete session._onStream;
    delete session._onStreamReset;
    if (session._abortSignal === signal) delete session._abortSignal;
  }
  if (result.streamedInline) {
    return streamedContent.trim() || formatLlmUnavailableMessage('flux vide');
  }
  if (result.response != null) return result.response;
  if (result.readyToStream && session.llm?.stream) {
    const { system, messages: streamMessages = [] } = result.streamContext ?? {};
    let content = '';
    for await (const delta of session.llm.stream({
      system: system ?? buildAgentSystemPrompt({ input, session }),
      messages: streamMessages,
      signal,
    })) {
      content += delta;
    }
    return content.trim() || formatLlmUnavailableMessage('flux vide');
  }
  return formatLlmUnavailableMessage('reponse vide');
}

export async function runAgenticLoop(agent, session, initialInput, {
  maxTurns,
  timeoutMs,
  signal = null,
  runId = null,
  runTurn = runAgentTurn,
  waitForActivities,
  planOrigin = 'llm',
  onTurnStart = null,
  onTurnResponse = null,
  onAssistantMessage = null,
  onPlanExtracted = null,
  onPlanAlreadySet = null,
  onComplete = null,
  onPendingSteps = null,
  onActivitiesStarted = null,
  onActivitiesCompleted = null,
  deterministicTerminalSummary = false,
  onMaxTurns = null,
  abortMessage = 'Agent run cancelled.',
  parallelHandoff = false,
} = {}) {
  if (!waitForActivities) throw new Error('runAgenticLoop requires waitForActivities.');
  const conversationHistory = [];
  let currentInput = initialInput;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    throwIfAborted(signal, abortMessage);
    if (session._currentRunIdentity && runId) {
      session._currentRunIdentity.turnId = `${runId}:turn-${turn}`;
    }
    onTurnStart?.({ turn, maxTurns });

    const snapshot = activitySnapshot(session);
    const response = await runTurn(agent, session, currentInput, {
      messages: conversationHistory,
      signal,
    });
    onTurnResponse?.({ turn, response });
    onAssistantMessage?.({ response, runId });

    conversationHistory.push(
      { role: 'user', content: currentInput },
      { role: 'assistant', content: response },
    );

    if (turn === 1) {
      if (session.headlessPlan === null) {
        const extractedPlan = extractHeadlessPlan(response);
        if (extractedPlan) {
          dispatchAgentEvent(session, createAgentEvent('plan_set', {
            origin: planOrigin,
            runId,
            payload: { steps: extractedPlan },
          }));
          onPlanExtracted?.({ steps: session.headlessPlan ?? extractedPlan, fallback: true });
        }
      } else {
        onPlanAlreadySet?.({ steps: session.headlessPlan });
      }
    }
    sanitizeSessionPlan(session, { runId });

    const newPending = newNonTerminalActivities(snapshot, session);
    if (newPending.length === 0) {
      // pending_approval is unfinished work too (a request_approval patch op
      // sets it) — it must not be treated as "nothing left to do" just
      // because no step is literally 'pending' anymore.
      const pending = (session.headlessPlan ?? []).filter((step) => step.status === 'pending' || step.status === 'pending_approval');
      const pendingSteps = readyPlanTasks(session.headlessPlan);
      if (pending.length === 0) {
        onComplete?.();
        return { ok: true };
      }
      if (pendingSteps.length === 0) {
        const reason = pending.every((step) => step.status === 'pending_approval') ? 'awaiting_approval' : 'no_ready_plan_task';
        onPendingSteps?.({ pendingSteps: pending, blocked: true });
        return { ok: false, stalled: true, reason };
      }
      if (parallelHandoff && pendingSteps.length > 1) {
        return { ok: true, handoff: true };
      }
      onPendingSteps?.({ pendingSteps });
      currentInput = pendingStepsPrompt(initialInput, session.headlessPlan, pendingSteps[0]);
      continue;
    }

    onActivitiesStarted?.({ activities: newPending });
    const waitResult = await waitForActivities(session, newPending, { timeoutMs, signal });
    if (!waitResult.ok) {
      return {
        ok: false,
        timedOut: Boolean(waitResult.timedOut),
        completed: waitResult.completed ?? [],
        waitResult,
      };
    }

    const completed = waitResult.completed ?? [];
    const summary = formatCompletedActivities(completed);
    onActivitiesCompleted?.({ completed, summary });
    const unfinished = (session.headlessPlan ?? []).some((step) =>
      ['pending', 'pending_approval', 'running', 'starting', 'queued'].includes(String(step.status ?? '').toLowerCase()));
    if (deterministicTerminalSummary && !unfinished) {
      return { ok: true, completed, summary, deterministicSummary: true };
    }
    if (parallelHandoff && readyPlanTasks(session.headlessPlan).length > 1) {
      return { ok: true, handoff: true };
    }
    currentInput = completedActivitiesPrompt(initialInput, session.headlessPlan, summary);
  }

  onMaxTurns?.({ maxTurns });
  return { ok: false, maxTurns: true };
}

function sanitizeSessionPlan(session, { runId = null } = {}) {
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

function pendingStepsPrompt(initialInput, plan, readyTask) {
  return [
    'Original task:',
    initialInput,
    '',
    `Plan status:\n${formatPlanStatus(plan)}`,
    '',
    formatReadyTaskPrompt(readyTask),
    '',
    'No new background activity was started in the previous turn.',
    'Continue the original plan. Start exactly this next ready task only.',
    'Do not start tasks whose dependencies are not done.',
    'If required information is missing and cannot be inferred, stop with a clear blocker.',
  ].join('\n');
}

function completedActivitiesPrompt(initialInput, plan, summary) {
  return [
    'Original task:',
    initialInput,
    '',
    plan ? `Plan status:\n${formatPlanStatus(plan)}\n` : null,
    'Completed activities:',
    summary,
    '',
    formatReadyTaskPrompt(nextReadyPlanTask(plan)),
    '',
    'Continue the original plan. Start exactly this next ready task only.',
    'Do not start tasks whose dependencies are not done.',
    'If all steps are complete, provide the final summary.',
  ].filter(Boolean).join('\n');
}
