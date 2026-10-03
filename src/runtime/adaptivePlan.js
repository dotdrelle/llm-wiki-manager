import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { contractSchemas } from '../contracts/schemas.js';
import { capabilityRegistryForSession } from '../orchestrator/capabilityRegistry.js';
import { applyApprovalCoverage } from '../orchestrator/approvalPolicy.js';
import { validateFragment, validateJsonSchema } from '../orchestrator/planValidator.js';
import { isFailed, isSkipped, isSuccessful, isTerminal } from '../orchestrator/taskStatuses.js';
import { sanitizeDiagnostic } from './failureRecovery.js';

export function explicitlyReadOnly(provider) {
  const cap = provider?.capability;
  return cap?.readOnly === true && !cap.mutationClass && cap.defaultRequiresApproval !== true && cap.requiresApproval !== true;
}

// Install a concrete replacement or missing-work tail. The model cannot edit
// completed tasks, grant approvals, select arbitrary providers or erase audit.
export function installAdaptivePlan(session, proposal, { runId, basePlanRevision, failure, fingerprints = new Set() } = {}) {
  const plan = session.headlessPlan ?? [];
  if (!runId || Number(session.planRevision ?? 0) !== basePlanRevision) return refuse('plan changed during investigation');
  if (!plan.every((task) => isTerminal(task.status))) return refuse('execution has not settled');
  if (!Array.isArray(proposal.tasks) || !proposal.tasks.length || proposal.tasks.length > 6) return refuse('invalid follow-up task count');
  const registry = capabilityRegistryForSession(session);
  const failed = proposal.replaceTaskId ? plan.find((task) => task.id === proposal.replaceTaskId) : null;
  if (proposal.replaceTaskId && (!failed || !isFailed(failed.status) || failure?.taskId !== failed.id)) return refuse('only the diagnosed failure can be replaced');
  if (!failed && plan.some((task) => isFailed(task.status))) return refuse('failed actions cannot be bypassed by appending work');
  if (failed) {
    const original = registry.providersFor(failed.requiredCapability).find((provider) => provider.agentInstanceId === failure.assignment?.agentInstanceId);
    if (!explicitlyReadOnly(original) && (failure.result?.executionContext?.rejectedBeforeExecution !== true || failure.result?.jobId)) return refuse('external effects are uncertain; replacement refused');
    if (/auth|credential|scope_missing|reauthoriz/i.test(String(failure.result?.error?.code ?? failure.result?.error?.message ?? ''))) return refuse('authorization requires user intervention');
  }
  if (sanitizeDiagnostic(proposal.tasks).redacted) return refuse('sensitive proposal');
  const signature = createHash('sha256').update(JSON.stringify(proposal.tasks.map((task) => [task.requiredCapability, task.operation, task.arguments]))).digest('hex');
  if (fingerprints.has(signature)) return refuse('no progress: repeated proposal');
  const revision = basePlanRevision + 1;
  const localIds = new Set();
  const tasks = [];
  for (const item of proposal.tasks) {
    if (typeof item.id !== 'string' || !item.id || localIds.has(item.id)) return refuse('duplicate or absent task identity');
    localIds.add(item.id);
    if (!item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) return refuse('arguments required');
    const providers = registry.providersFor(item.requiredCapability).filter((p) => p.capability.supportedOperations?.includes(item.operation)
      && validateJsonSchema(p.capability.inputSchema, item.arguments).length === 0);
    if (!providers.length) return refuse('no compatible published capability or arguments');
    // Read-only bypass is valid only when every compatible provider declares it.
    const readOnly = providers.every(explicitlyReadOnly);
    if (!readOnly && plan.some((task) => isSuccessful(task.status) && task.requiredCapability === item.requiredCapability
      && task.operation === item.operation && isDeepStrictEqual(task.arguments, item.arguments))) return refuse('completed action cannot be repeated');
    if (Object.hasOwn(item.arguments, 'workspace') && item.arguments.workspace !== session.workspace) return refuse('workspace mismatch');
    const locks = Array.isArray(item.locks) ? item.locks : [];
    const task = { id: item.id, label: String(item.label ?? item.id), requiredCapability: item.requiredCapability,
      operation: item.operation, arguments: structuredClone(item.arguments), dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [],
      locks: [...new Set([...locks, ...(failed?.locks ?? [])])], parallelizable: false, inputRefs: [],
      requiresApproval: !readOnly, progressWeight: 1,
      idempotencyKey: createHash('sha256').update(`${runId}:${revision}:${item.id}`).digest('hex'),
      approvalSummary: `${proposal.summary ?? 'Objective follow-up'}\nProposed arguments: ${JSON.stringify(item.arguments)}` };
    tasks.push(task);
  }
  const fragment = { contractVersion: '1', agentInstanceId: 'donna-supervisor', capability: 'objective.follow-up',
    summary: { label: 'Objective follow-up', estimatedTasks: tasks.length, initialSynthesis: [] }, groups: [], tasks };
  const valid = validateFragment(fragment, { registry, budgets: { maxTasks: 6, maxDepth: 6 } });
  if (!valid.ok) return refuse(valid.errors.map((error) => error.code).join(', '));
  const normalized = valid.normalizedFragment.tasks;
  // Single completion frontier: dependents must wait for every terminal node
  // of a replacement chain, not whichever task appeared last in model JSON.
  const depended = new Set(normalized.flatMap((task) => task.dependsOn));
  const leaves = normalized.filter((task) => !depended.has(task.id));
  const affected = new Set(failed ? [failed.id] : []);
  for (let pass = 0; pass < plan.length; pass++) for (const task of plan) {
    if (isSkipped(task.status) && task.dependsOn?.some((id) => affected.has(id))) affected.add(task.id);
  }
  if (plan.some((task) => task.dependsOnGroup && (affected.has(task.id) || plan.some((member) => affected.has(member.id) && member.groupId === task.dependsOnGroup)))) return refuse('group dependencies require an explicit plan');
  const ids = new Map(normalized.map((task) => [task.id, `supervisor-${revision}-${task.id}`]));
  const descendants = new Map([...affected].filter((id) => id !== failed?.id).map((id) => [id, `${id}:recovery-${revision}`]));
  const reset = (task, recoveryOf) => {
    const clean = { ...task, status: task.requiresApproval ? 'waiting_approval' : 'pending', recoveryOf, recoveryRevision: revision, outputRefs: [] };
    for (const key of ['error', 'result', 'approved', 'approvalStatus', 'retryState', 'retryAssignment', 'ownerActivityKey', '_activityKey']) delete clean[key];
    return clean;
  };
  const added = normalized.map((task) => reset({ ...task, id: ids.get(task.id), dependsOn: task.dependsOn.map((id) => ids.get(id)) }, failed?.id ?? `objective:${runId}`));
  const retained = plan.filter((task) => task.id !== failed?.id).map((task) => {
    if (!affected.has(task.id)) return { ...task };
    return reset({ ...task, id: descendants.get(task.id), requiresApproval: true,
      idempotencyKey: createHash('sha256').update(`${runId}:${revision}:${task.id}`).digest('hex'),
      dependsOn: task.dependsOn.flatMap((id) => id === failed.id ? leaves.map((leaf) => ids.get(leaf.id)) : [descendants.get(id) ?? id]) }, task.id);
  });
  const next = [...retained, ...added];
  if (new Set(next.map((task) => task.id)).size !== next.length) return refuse('task identity collision');
  // Validate the full graph again, including preserved completed dependencies.
  const allIds = new Map(next.map((task, index) => [task.id, `t-${index}`]));
  const groupIds = [...new Set(next.flatMap((task) => [task.groupId, task.dependsOnGroup]).filter(Boolean))];
  const groups = new Map(groupIds.map((id, index) => [id, `g-${index}`]));
  const full = validateFragment({ ...fragment, groups: [...groups.values()].map((id) => ({ id, label: id })),
    summary: { ...fragment.summary, estimatedTasks: next.length },
    tasks: next.map((task) => ({ ...Object.fromEntries(Object.entries(task).filter(([key, value]) => Object.hasOwn(contractSchemas.plannedTask.properties, key) && value != null)),
      id: allIds.get(task.id), dependsOn: task.dependsOn.map((id) => allIds.get(id) ?? id),
      ...(task.groupId ? { groupId: groups.get(task.groupId) } : {}), ...(task.dependsOnGroup ? { dependsOnGroup: groups.get(task.dependsOnGroup) } : {}) })) }, { registry });
  if (!full.ok) return refuse(full.errors.map((error) => error.code).join(', '));
  fingerprints.add(signature);
  const requests = applyApprovalCoverage(next, { runId, workspaceId: session.workspace, planRevision: revision, approvals: session.agentProjection?.approvals ?? [] });
  dispatchAgentEvent(session, createAgentEvent('plan.revision_changed', { origin: 'objective_supervisor', runId,
    payload: { runId, planRevision: revision, previousRevision: basePlanRevision, tasks: next } }));
  for (const request of requests) dispatchAgentEvent(session, createAgentEvent('approval.requested', { origin: 'objective_supervisor', runId, taskId: request.taskId, payload: request }));
  return { recovered: true, revision, approvalRequired: requests.length > 0, signature };
}

function refuse(reason) { return { recovered: false, reason }; }
