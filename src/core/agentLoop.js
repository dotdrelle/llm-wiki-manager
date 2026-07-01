import { buildAgentSystemPrompt, buildLimitedAgentResponse } from '../agent/graph.js';
import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';
import { activitySnapshot, newNonTerminalActivities } from './activity.js';
import { extractHeadlessPlan, formatCompletedActivities, formatPlanStatus } from './plan.js';

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
  let result;
  try {
    result = await agent.invoke({ input, session, messages });
  } finally {
    delete session._onStream;
    delete session._onStreamReset;
  }
  if (result.streamedInline) {
    return streamedContent.trim() || buildLimitedAgentResponse({ input, session }, 'LLM stream ended without content');
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
    return content.trim() || buildLimitedAgentResponse({ input, session }, 'LLM stream ended without content');
  }
  return buildLimitedAgentResponse({ input, session });
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
  onMaxTurns = null,
  abortMessage = 'Agent run cancelled.',
} = {}) {
  if (!waitForActivities) throw new Error('runAgenticLoop requires waitForActivities.');
  const conversationHistory = [];
  let currentInput = initialInput;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    throwIfAborted(signal, abortMessage);
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

    if (turn === 1 && session.headlessPlan === null) {
      const extractedPlan = extractHeadlessPlan(response);
      if (extractedPlan) {
        dispatchAgentEvent(session, createAgentEvent('plan_set', {
          origin: planOrigin,
          runId,
          payload: { steps: extractedPlan },
        }));
        onPlanExtracted?.({ steps: session.headlessPlan ?? extractedPlan, fallback: true });
      }
    } else if (turn === 1 && session.headlessPlan) {
      onPlanAlreadySet?.({ steps: session.headlessPlan });
    }

    const newPending = newNonTerminalActivities(snapshot, session);
    if (newPending.length === 0) {
      const pendingSteps = (session.headlessPlan ?? []).filter((step) => step.status === 'pending');
      if (pendingSteps.length === 0) {
        onComplete?.();
        return { ok: true };
      }
      onPendingSteps?.({ pendingSteps });
      currentInput = pendingStepsPrompt(initialInput, session.headlessPlan);
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

    const summary = formatCompletedActivities(waitResult.completed ?? []);
    onActivitiesCompleted?.({ completed: waitResult.completed ?? [], summary });
    currentInput = completedActivitiesPrompt(initialInput, session.headlessPlan, summary);
  }

  onMaxTurns?.({ maxTurns });
  return { ok: false, maxTurns: true };
}

function pendingStepsPrompt(initialInput, plan) {
  return [
    'Original task:',
    initialInput,
    '',
    `Plan status:\n${formatPlanStatus(plan)}`,
    '',
    'No new background activity was started in the previous turn.',
    'Continue the original plan. Start the next pending step only.',
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
    'Continue the original plan. Start the next required step only.',
    'If all steps are complete, provide the final summary.',
  ].filter(Boolean).join('\n');
}
