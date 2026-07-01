import { buildAgentSystemPrompt, buildLimitedAgentResponse } from '../agent/graph.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { activitySnapshot, newNonTerminalActivities, sessionActivities, terminalFailures } from '../core/activity.js';
import { extractHeadlessPlan, formatCompletedActivities, formatPlanStatus } from '../core/plan.js';
import { emitRuntimeLog, pollActivitiesOnce } from './supervisor.js';

function abortError() {
  const err = new Error('Runtime run cancelled.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function runRuntimeAgentTurn(agent, session, input, messages = []) {
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
      signal: session._abortSignal,
    })) {
      content += delta;
    }
    return content.trim() || buildLimitedAgentResponse({ input, session }, 'LLM stream ended without content');
  }
  return buildLimitedAgentResponse({ input, session });
}

async function waitForRuntimeActivities(session, startedActivities, { timeoutMs, signal, pollBusy }) {
  const deadline = Date.now() + timeoutMs;
  const trackedKeys = new Set(startedActivities.map((activity) => activity.key));
  emitRuntimeLog(session, `activity-loop: tracking ${trackedKeys.size} activity(s)`);

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    await pollActivitiesOnce(session, { pollBusy, signal });
    const tracked = sessionActivities(session).filter((activity) => trackedKeys.has(activity.key));
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
  return {
    ok: false,
    timedOut: true,
    completed: sessionActivities(session).filter((activity) => trackedKeys.has(activity.key)),
  };
}

export async function runRuntimeAgenticLoop(agent, session, initialInput, { signal, timeoutMs, maxTurns, runId, pollBusy }) {
  const conversationHistory = [];
  let currentInput = initialInput;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    throwIfAborted(signal);
    emitRuntimeLog(session, `agentic-loop: turn ${turn}/${maxTurns}`);
    const snapshot = activitySnapshot(session);
    const response = await runRuntimeAgentTurn(agent, session, currentInput, conversationHistory);
    const lastMessage = session.agentProjection?.conversation?.at(-1);
    if (lastMessage?.role !== 'assistant' || lastMessage.content !== response) {
      dispatchAgentEvent(session, createAgentEvent('assistant_message', {
        origin: 'agent',
        runId,
        payload: { content: response },
      }));
    }

    conversationHistory.push(
      { role: 'user', content: currentInput },
      { role: 'assistant', content: response },
    );

    if (turn === 1 && session.headlessPlan === null) {
      const extractedPlan = extractHeadlessPlan(response);
      if (extractedPlan) {
        dispatchAgentEvent(session, createAgentEvent('plan_set', {
          origin: 'llm',
          payload: { steps: extractedPlan },
        }));
        emitRuntimeLog(session, `agentic-loop: plan extracted from text (${session.headlessPlan.length} steps)`);
      }
    }

    const newPending = newNonTerminalActivities(snapshot, session);
    if (newPending.length === 0) {
      const pendingSteps = (session.headlessPlan ?? []).filter((step) => step.status === 'pending');
      if (pendingSteps.length === 0) {
        emitRuntimeLog(session, 'agentic-loop: no pending activity or plan step');
        return { ok: true };
      }
      emitRuntimeLog(session, `agentic-loop: ${pendingSteps.length} pending step(s), continuing`);
      currentInput = [
        'Original task:',
        initialInput,
        '',
        `Plan status:\n${formatPlanStatus(session.headlessPlan)}`,
        '',
        'No new background activity was started in the previous turn.',
        'Continue the original plan. Start the next pending step only.',
        'If required information is missing and cannot be inferred, stop with a clear blocker.',
      ].join('\n');
      continue;
    }

    emitRuntimeLog(session, `agentic-loop: ${newPending.length} new activity(s), waiting`);
    const waitResult = await waitForRuntimeActivities(session, newPending, { timeoutMs, signal, pollBusy });
    if (!waitResult.ok) return { ok: false, timedOut: waitResult.timedOut, completed: waitResult.completed };

    const summary = formatCompletedActivities(waitResult.completed);
    currentInput = [
      'Original task:',
      initialInput,
      '',
      session.headlessPlan ? `Plan status:\n${formatPlanStatus(session.headlessPlan)}\n` : null,
      'Completed activities:',
      summary,
      '',
      'Continue the original plan. Start the next required step only.',
      'If all steps are complete, provide the final summary.',
    ].filter(Boolean).join('\n');
  }

  emitRuntimeLog(session, `agentic-loop: max turns (${maxTurns}) reached`);
  return { ok: false, maxTurns: true };
}
