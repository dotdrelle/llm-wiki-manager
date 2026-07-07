import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';

export function createResultAggregator({ session = null, runId = null, store = null } = {}) {
  return {
    accept(result, options = {}) {
      return accept(result, {
        session,
        runId,
        store,
        ...options,
      });
    },
  };
}

export async function accept(result, {
  session,
  runId = null,
  task = null,
  assignment = null,
  store = null,
} = {}) {
  if (!session) throw new Error('resultAggregator.accept requires session.');
  const taskId = String(result?.taskId ?? task?.id ?? task?.step ?? '');
  const ok = resultOk(result);
  const status = cancelled(result) ? 'cancelled' : ok ? 'done' : 'failed';
  const payload = {
    runId,
    taskId,
    result,
    assignment: assignment ? {
      agentInstanceId: assignment.agentInstanceId,
      serverName: assignment.serverName ?? null,
    } : null,
  };
  persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('task.result_returned', {
    origin: 'result_aggregator',
    runId,
    taskId,
    payload,
  })));
  persistDispatch(store, dispatchAgentEvent(session, createAgentEvent('plan_step_updated', {
    origin: 'result_aggregator',
    runId,
    taskId,
    payload: {
      taskId,
      status,
      outputRefs: normalizeOutputRefs(result?.outputRefs ?? result?.result?.outputRefs),
      result,
    },
  })));
  persistDispatch(store, dispatchAgentEvent(session, createAgentEvent(ok ? 'task.completed' : 'task.failed', {
    origin: 'result_aggregator',
    runId,
    taskId,
    payload,
  })));
  return { ok, status };
}

function resultOk(result) {
  const status = String(result?.status ?? result?.result?.status ?? '').toLowerCase();
  return result?.ok === true || ['succeeded', 'success', 'done', 'complete', 'completed'].includes(status);
}

function cancelled(result) {
  return ['cancelled', 'canceled'].includes(String(result?.status ?? result?.result?.status ?? '').toLowerCase());
}

function normalizeOutputRefs(value) {
  return Array.isArray(value) ? value.map((ref) => (ref && typeof ref === 'object' ? { ...ref } : String(ref))) : [];
}

function persistDispatch(store, event) {
  store?.persistEvent?.(event);
}
