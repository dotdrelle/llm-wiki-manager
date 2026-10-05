import { sanitizePlanForExecution } from './planPatch.js';
import { createAgentEvent, dispatchAgentEvent } from './agentEvents.js';

export function sanitizeSessionPlanForExecution(session, runId = null) {
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
