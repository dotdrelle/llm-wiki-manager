import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { capabilityRegistryForSession } from '../orchestrator/capabilityRegistry.js';
import { isFailed, isSuccessful, isTerminal } from '../orchestrator/taskStatuses.js';
import { failureDiagnostics, installRecoveryPlan, safeSummary, sanitizeDiagnostic } from './failureRecovery.js';
import { investigateRun } from './orchestrationDiagnostics.js';
import { explicitlyReadOnly, installAdaptivePlan } from './adaptivePlan.js';
import { phraseFactsForUser } from './userFacts.js';
import { emitRuntimeLog } from './supervisor.js';

export const MAX_SUPERVISOR_CHECKPOINTS = 3;

/*
 Whether a SUCCESSFUL run still needs the supervisor's objective check (one
 model call, plus diagnostics). It used to run after every success — a model
 call per run on a provider already hitting its per-minute quota. It runs only
 when the success is not already established: the evaluation has a doubt, or a
 mutating task succeeded without its agent's own post-action verification.
 A read-only run, or one whose every mutation was verified, needs no check.
 */
export function successCheckWarranted(session, plan = [], evaluation = null) {
  if (evaluation && evaluation.ok === false) return true;
  const registry = capabilityRegistryForSession(session);
  return (Array.isArray(plan) ? plan : []).some((task) => {
    if (!isSuccessful(task.status)) return false;
    const providers = registry.providersFor(task.requiredCapability);
    const readOnly = providers.length > 0 && providers.every(explicitlyReadOnly) && task.requiresApproval !== true;
    if (readOnly) return false;
    const verification = task.result?.rawStatus?.result?.verification ?? task.result?.verification;
    // `not_applicable` is a dry run: nothing real happened, so there is no
    // result to look for. Checking it only produced a degraded investigation
    // and a notice contradicting the successful simulation.
    return !['verified', 'not_applicable'].includes(verification?.status);
  });
}

export async function superviseObjective(session, objective, result, { runId, signal, callTool, state, evaluation } = {}) {
  const plan = session.headlessPlan ?? [];
  if (signal?.aborted) throw signal.reason;
  if (!plan.length || !plan.every((task) => isTerminal(task.status)) || result?.budgetExceeded) return { recovered: false };
  if (state.checkpoints >= MAX_SUPERVISOR_CHECKPOINTS) {
    await announce(session, runId, `Orchestration stopped: the investigation/replanning budget (${MAX_SUPERVISOR_CHECKPOINTS} checkpoints) is exhausted. Completed work is preserved; the remaining work requires user intervention.`, signal);
    return { recovered: false, diagnosed: true, exhausted: true };
  }
  state.checkpoints++;
  if (!session.llm?.completeWithTools) return { recovered: false };
  const revision = Number(session.planRevision ?? 0);
  const failure = result?.failures?.find((item) => isFailed(item.result?.status) && !item.cancelled);
  const task = plan.find((item) => item.id === failure?.taskId);
  const registry = capabilityRegistryForSession(session);
  const capabilities = registry.snapshot?.() ?? Object.fromEntries([...new Set(plan.map((item) => item.requiredCapability))].map((id) => [id, registry.providersFor(id)]));
  const provider = task ? registry.providersFor(task.requiredCapability).find((item) => item.agentInstanceId === failure?.assignment?.agentInstanceId) : null;
  const history = session._readOrchestrationIncidents?.() ?? (session.agentEvents ?? []).slice(-1000)
    .filter((event) => event.payload?.supervisorIncident && event.payload.supervisorIncident.workspace === session.workspace)
    .slice(-5).map((event) => event.payload.supervisorIncident);
  const facts = { objective, workspace: session.workspace, checkpoint: state.checkpoints, evaluation,
    task: task ? { id: task.id, label: task.label, capability: task.requiredCapability, operation: task.operation } : null,
    arguments: failure?.result?.executionContext?.arguments ?? task?.arguments,
    rejectedBeforeExecution: failure?.result?.executionContext?.rejectedBeforeExecution === true,
    error: failure?.result?.error,
    completed: plan.map((item) => ({ id: item.id, label: item.label, status: item.status, capability: item.requiredCapability,
      operation: item.operation, arguments: item.arguments, outputRefs: item.outputRefs,
      evidence: item.result?.rawStatus?.result ?? item.result })),
    failures: failureDiagnostics(session, plan),
    capabilities: Object.values(capabilities).flat().map((item) => ({ id: item.capability.id, description: item.capability.description,
      supportedOperations: item.capability.supportedOperations, inputSchema: item.capability.inputSchema,
      readOnly: item.capability.readOnly, mutationClass: item.capability.mutationClass, defaultRequiresApproval: item.capability.defaultRequiresApproval })),
    recentLogs: (session.agentEvents ?? []).slice(-100).filter((event) => event.type === 'runtime_log').slice(-12).map((event) => event.payload?.message ?? event.payload?.line),
    historicalIncidents: history };
  const diagnosis = await investigateRun(session, facts, { signal, runId, callTool });
  if (signal?.aborted) throw signal.reason;
  const proposal = diagnosis.proposal;
  let recovery = { recovered: false };
  if (!diagnosis.restricted && Number(session.planRevision ?? 0) === revision) {
    if (proposal?.action === 'retry' && proposal.arguments && typeof proposal.arguments === 'object' && !Array.isArray(proposal.arguments)
      && !sanitizeDiagnostic(proposal.arguments).redacted && task && provider && !state.correctedTasks.has(task.recoveryOf ?? task.id)
      && failure.result?.executionContext?.rejectedBeforeExecution === true && !failure.result?.jobId
      && /^invalid_arguments\b/.test(String(failure.result?.error?.code ?? failure.result?.error?.message ?? ''))) {
      recovery = installRecoveryPlan(session, task, provider, proposal.arguments, { registry, runId,
        summary: safeSummary(proposal.summary), sentArguments: failure.result.executionContext.arguments, basePlanRevision: revision });
      if (recovery.recovered) state.correctedTasks.add(task.recoveryOf ?? task.id);
    } else if (proposal?.action === 'replan') {
      recovery = installAdaptivePlan(session, proposal, { runId, basePlanRevision: revision, failure, fingerprints: state.fingerprints });
    }
  }
  const failedPlan = plan.some((item) => isFailed(item.status));
  const blocked = !recovery.recovered && (proposal?.action === 'blocked' || (proposal?.action === 'complete' && failedPlan));
  const summary = safeSummary(proposal?.summary) || (failedPlan
    ? `Execution failed: ${safeSummary(failure?.result?.error?.message ?? failure?.result?.error?.code ?? 'see task diagnostics')}. No safe continuation was established.`
    : 'Execution receipts are available; the objective could not be independently assessed.');
  const suffix = recovery.recovered ? recovery.approvalRequired === false
    ? ' Read-only follow-up prepared; execution continues.' : ' Follow-up prepared; fresh approval is required before mutations.'
    : proposal?.action === 'retry' || proposal?.action === 'replan' ? ` Follow-up refused: ${recovery.reason ?? 'no validated safe proposal'}.` : '';
  // A degraded investigation is announced when it matters to the user — a
  // failure or a block. On a success it is logged: the run outcome already
  // states what was (not) verified, and a second notice contradicted it.
  if (diagnosis.degraded && !(failedPlan || recovery.recovered || blocked)) {
    emitRuntimeLog(session, 'orchestrator: objective check degraded after a success; outcome left to the run evaluation');
  }
  if (failedPlan || recovery.recovered || blocked) await announce(session, runId,
    `Diagnosis: ${summary}${suffix}${diagnosis.degraded ? ' Investigation degraded or bounded; missing evidence is not a success proof.' : ''}`, signal);
  const incident = { workspace: session.workspace, capability: task?.requiredCapability ?? null,
    errorCode: /^[a-zA-Z0-9_-]+/.exec(String(failure?.result?.error?.code ?? ''))?.[0] ?? null,
    removedArgumentNames: recovery.recovered && proposal?.action === 'retry'
      ? Object.keys(failure.result.executionContext.arguments ?? {}).filter((key) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && !Object.hasOwn(proposal.arguments, key)) : [],
    decision: recovery.recovered ? 'follow-up' : 'stop',
    revisedCapabilities: recovery.recovered ? [...new Set(session.headlessPlan.filter((item) => item.recoveryRevision > revision).map((item) => item.requiredCapability))] : [],
    diagnosticCalls: diagnosis.calls, checkpoint: state.checkpoints };
  dispatchAgentEvent(session, createAgentEvent('orchestration.checkpoint', { origin: 'objective_supervisor', runId, workspace: session.workspace,
    payload: { message: `orchestrator: checkpoint ${state.checkpoints}/${MAX_SUPERVISOR_CHECKPOINTS}; ${incident.decision}; diagnostics=${diagnosis.calls}`, supervisorIncident: incident } }));
  return { ...recovery, diagnosed: failedPlan, blocked, reason: summary, degraded: diagnosis.degraded };
}

// The supervisor states FACTS (English data); Donna words them in the
// session language. Raw English notices used to land in every chat as is.
async function announce(session, runId, facts, signal = null) {
  const content = await phraseFactsForUser(session, facts, { signal, rules: [
    'When a follow-up awaits approval, say that nothing new runs before the user approves it.',
    'When the orchestration stopped or is blocked, say what was accomplished, what remains and who must act.',
  ] });
  dispatchAgentEvent(session, createAgentEvent('assistant_message', { origin: 'objective_supervisor', runId, payload: { content } }));
}
