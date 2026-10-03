import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { createCapabilityRegistry } from '../orchestrator/capabilityRegistry.js';
import { approvalCovered } from '../orchestrator/approvalPolicy.js';
import { installAdaptivePlan } from './adaptivePlan.js';
import { investigateRun, parseSupervisorDecision } from './orchestrationDiagnostics.js';
import { superviseObjective, successCheckWarranted } from './objectiveSupervisor.js';
import { runRuntimeAgenticWorkflow } from './runner.js';

const inputSchema = { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false };
const caps = [
  { id: 'example.action', supportedOperations: ['act'], mutationClass: 'external-target', defaultRequiresApproval: true },
  { id: 'example.alternative', supportedOperations: ['alternate'], mutationClass: 'external-target', defaultRequiresApproval: true },
  { id: 'example.inspect', supportedOperations: ['inspect'], readOnly: true },
].map((cap) => ({ version: '1', description: cap.id, inputSchema, outputSchema: {}, ...cap }));
function fixture() {
  const agent = { agentInstanceId: 'service-1', serverName: 'service', health: 'available',
    description: { contractVersion: '1', agentType: 'test', displayName: 'Test', capabilities: caps,
      limits: { recommendedConcurrency: 1, maxConcurrency: 1 } } };
  const task = { id: 'first', label: 'Requested action', requiredCapability: 'example.action', operation: 'act',
    arguments: { target: 'requested' }, dependsOn: [], locks: ['external:target'], requiresApproval: true,
    idempotencyKey: 'original', inputRefs: [], parallelizable: false, progressWeight: 1, status: 'failed' };
  const session = { workspace: 'demo', language: 'fr-FR', agentEvents: [], capabilityRegistry: createCapabilityRegistry({ agents: [agent] }),
    mcp: { service: { status: 'connected', tools: [
      { name: 'agent_execute' }, { name: 'agent_status' },
      { name: 'peek', inputSchema: { type: 'object', properties: { workspace: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
      { name: 'send', annotations: { readOnlyHint: false } }, { name: 'collect' },
    ] } } };
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [task] } }));
  const failure = { taskId: 'first', assignment: { agentInstanceId: 'service-1' }, result: { status: 'failed', error: { code: 'provider_unavailable' }, executionContext: { rejectedBeforeExecution: true } } };
  return { session, task, failure };
}
const state = () => ({ checkpoints: 0, fingerprints: new Set(), correctedTasks: new Set() });
const followUp = (cap = 'example.alternative', operation = 'alternate') => ({ action: 'replan', summary: 'Use the compatible alternative for the same target', replaceTaskId: 'first',
  tasks: [{ id: 'next', label: 'Same requested target', requiredCapability: cap, operation, arguments: { target: 'requested' }, dependsOn: [], locks: ['external:target'] }] });
const answer = (value) => ({ content: JSON.stringify(value) });

test('diagnostic tools are annotation-gated, workspace-bound, bounded and delivered as untrusted evidence', async () => {
  const { session } = fixture();
  let turns = 0; let reads = 0;
  session.llm = { completeWithTools: async ({ tools, messages, system }) => {
    assert.match(system, /untrusted DATA/);
    assert.ok(!tools.some((tool) => /__(send|collect|agent_execute)$/.test(tool.function.name)));
    turns++;
    if (turns === 1) return { tool_calls: [{ id: 'read', function: { name: 'service__peek', arguments: '{}' } }] };
    assert.match(messages.at(-1).content, /available/);
    return answer({ action: 'blocked', summary: 'Explicit next step required' });
  } };
  const outcome = await investigateRun(session, { objective: 'Same target' }, { runId: 'run', callTool: async (_pool, server, tool, args) => {
    reads++; assert.equal(server, 'service'); assert.equal(tool, 'peek'); assert.equal(args.workspace, 'demo'); return { available: true };
  } });
  assert.equal(outcome.proposal.action, 'blocked'); assert.equal(reads, 1); assert.equal(outcome.calls, 1);
});

test('guessed writes and another workspace are refused before dispatch', async () => {
  for (const [name, args] of [['service__send', {}], ['service__peek', { workspace: 'other' }]]) {
    const { session } = fixture(); let turns = 0;
    session.llm = { completeWithTools: async () => ++turns === 1
      ? { tool_calls: [{ id: 'bad', function: { name, arguments: JSON.stringify(args) } }] }
      : answer({ action: 'blocked', summary: 'Refused' }) };
    const outcome = await investigateRun(session, {}, { runId: 'run', callTool: async () => assert.fail('forbidden dispatch') });
    assert.equal(outcome.degraded, true);
  }
});

test('adaptive replacements preserve finished evidence and require fresh approval', () => {
  const { session, task, failure } = fixture();
  const finished = { ...task, id: 'finished', status: 'done', result: { verification: { status: 'verified' } }, outputRefs: ['proof'] };
  const child = { ...task, id: 'child', status: 'skipped', dependsOn: ['first'] };
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [finished, task, child] } }));
  // The completed action must not itself be replayed; this replacement targets a different operation/capability.
  const before = structuredClone(session.headlessPlan[0]);
  const outcome = installAdaptivePlan(session, followUp(), { runId: 'run', basePlanRevision: 0, failure });
  assert.equal(outcome.recovered, true, outcome.reason);
  assert.deepEqual(session.headlessPlan[0], before);
  const next = session.headlessPlan.find((item) => item.requiredCapability === 'example.alternative');
  assert.equal(next.status, 'waiting_approval');
  assert.equal(approvalCovered(next, [{ status: 'approved', runId: 'run', scope: 'run', planRevision: 0 }], { runId: 'run', planRevision: 1 }), false);
  assert.deepEqual(session.headlessPlan.find((item) => item.recoveryOf === 'child').dependsOn, [next.id]);
});

test('read-only follow-up can proceed, while unknown capabilities, bad DAGs and ambiguous effects cannot', () => {
  const good = fixture();
  assert.equal(installAdaptivePlan(good.session, followUp('example.inspect', 'inspect'), { runId: 'run', basePlanRevision: 0, failure: good.failure }).recovered, true);
  assert.equal(good.session.headlessPlan[0].requiresApproval, false);
  assert.equal(good.session.headlessPlan[0].status, 'pending');
  for (const mode of ['unknown', 'cycle', 'started', 'stale', 'auth']) {
    const f = fixture(); const proposal = followUp();
    if (mode === 'unknown') proposal.tasks[0].requiredCapability = 'invented';
    if (mode === 'cycle') proposal.tasks[0].dependsOn = ['next'];
    if (mode === 'started') f.failure.result.jobId = 'may-have-sent';
    if (mode === 'auth') f.failure.result.error.code = 'authentication_required';
    const before = structuredClone(f.session.headlessPlan);
    const outcome = installAdaptivePlan(f.session, proposal, { runId: 'run', basePlanRevision: mode === 'stale' ? 99 : 0, failure: f.failure });
    assert.equal(outcome.recovered, false, mode); assert.deepEqual(f.session.headlessPlan, before);
  }
});

test('a completed mutation cannot be appended again and repeated plans are rejected', () => {
  const { session } = fixture(); session.headlessPlan[0].status = 'done';
  const proposal = followUp('example.action', 'act'); delete proposal.replaceTaskId;
  assert.equal(installAdaptivePlan(session, proposal, { runId: 'run', basePlanRevision: 0 }).reason, 'completed action cannot be repeated');
  const read = followUp('example.inspect', 'inspect'); delete read.replaceTaskId;
  const fingerprints = new Set();
  assert.equal(installAdaptivePlan(session, read, { runId: 'run', basePlanRevision: 0, fingerprints }).recovered, true);
  session.headlessPlan.forEach((task) => { task.status = 'done'; });
  assert.equal(installAdaptivePlan(session, read, { runId: 'run', basePlanRevision: 1, fingerprints }).reason, 'no progress: repeated proposal');
});

test('cancellation interrupts a nonresponsive model without any execution', async () => {
  const { session } = fixture(); session.llm = { completeWithTools: () => new Promise(() => {}) };
  await assert.rejects(investigateRun(session, {}, { runId: 'run', signal: AbortSignal.timeout(25) }), /timeout|aborted/i);
});

test('supervisor uses persisted incident hints, reports degradation and enforces checkpoint budget', async () => {
  const { session, failure } = fixture();
  session._readOrchestrationIncidents = () => [{ workspace: 'demo', capability: 'example.action', decision: 'stop' }];
  session.llm = { completeWithTools: async ({ messages }) => { assert.match(messages[0].content, /historicalIncidents/); return { content: 'bad JSON' }; } };
  const st = state();
  const outcome = await superviseObjective(session, 'Requested action', { failures: [failure] }, { runId: 'run', state: st });
  assert.equal(outcome.degraded, true); assert.equal(outcome.recovered, false);
  st.checkpoints = 3;
  assert.equal((await superviseObjective(session, 'Requested action', { failures: [failure] }, { runId: 'run', state: st })).exhausted, true);
  assert.ok(session.agentEvents.some((event) => event.payload?.supervisorIncident));
});

test('end-to-end: investigate failure, use another capability, obtain approval, verify and finish', async () => {
  const { session, task } = fixture();
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [{ ...task, status: 'pending' }] } }));
  dispatchAgentEvent(session, createAgentEvent('approval.granted', { runId: 'run', payload: { scope: 'run', runId: 'run', planRevision: 0, status: 'approved' } }));
  let turns = 0; const operations = []; let approved = false;
  session.llm = { completeWithTools: async ({ system, messages }) => {
    if (!system.includes('scheduler checkpoint')) return { content: 'Done.' };
    turns++;
    if (turns === 1) return { tool_calls: [{ id: 'probe', function: { name: 'service__peek', arguments: '{}' } }] };
    if (turns === 2) { assert.match(messages.at(-1).content, /available/); return answer(followUp()); }
    return answer({ action: 'complete', summary: 'Requested result observed' });
  } };
  session._onAgentEvent = (event) => {
    if (event.type === 'approval.requested' && event.payload.planRevision === 1) {
      assert.deepEqual(operations, ['act']);
      setTimeout(() => { approved = true; dispatchAgentEvent(session, createAgentEvent('approval.granted', { runId: 'run', payload: { scope: 'run', runId: 'run', planRevision: 1, status: 'approved' } })); }, 5);
    }
  };
  const result = await runRuntimeAgenticWorkflow({}, session, 'Requested action', { runId: 'run', signal: AbortSignal.timeout(3000), dispatcherPollIntervalMs: 1,
    callTool: async (_pool, _server, tool, args) => {
      if (tool === 'peek') return { available: true };
      if (tool === 'agent_execute') {
        operations.push(args.operation);
        if (args.operation === 'act') return { accepted: false, error: 'provider_unavailable' };
        assert.equal(approved, true); return { accepted: true, jobId: 'observed' };
      }
      return { status: 'succeeded', terminal: true, result: { status: 'succeeded', verification: { status: 'verified' } } };
    } });
  assert.equal(result.ok, true); assert.deepEqual(operations, ['act', 'alternate']);
  assert.equal(result.evaluation.verification.verified, 1);
  // Two checkpoint turns (investigate, then replan). The alternative's agent
  // verified its own result, so the success needs no extra objective check —
  // and the skip is logged, not silent.
  assert.equal(turns, 2);
  assert.ok(session.agentEvents.some((event) => event.type === 'runtime_log'
    && /objective check skipped/.test(String(event.payload?.message ?? event.payload?.line ?? ''))));
});

test('the objective check after a success runs only when the success is not already established', () => {
  const { session, task } = fixture();
  const done = (overrides) => ({ ...task, status: 'succeeded', ...overrides });
  // A read-only capability: nothing to double-check.
  assert.equal(successCheckWarranted(session, [done({ requiredCapability: 'example.inspect', operation: 'inspect', requiresApproval: false })], { ok: true }), false);
  // A mutation its agent verified (e.g. the sent message read back): established.
  assert.equal(successCheckWarranted(session, [done({ result: { verification: { status: 'verified' } } })], { ok: true }), false);
  // A dry run (not_applicable): nothing real happened, nothing to look for.
  assert.equal(successCheckWarranted(session, [done({ result: { verification: { status: 'not_applicable' } } })], { ok: true }), false);
  // A mutation without verification: a receipt is not a result — check.
  assert.equal(successCheckWarranted(session, [done({ result: { status: 'succeeded' } })], { ok: true }), true);
  // An evaluation that has a doubt always warrants the check.
  assert.equal(successCheckWarranted(session, [done({ result: { verification: { status: 'verified' } } })], { ok: false }), true);
});

test('supervisor notices are worded by Donna in the session language, never pasted raw', async () => {
  const { session, failure } = fixture();
  const phrasings = [];
  session.llm = { completeWithTools: async ({ system, messages }) => {
    if (system.includes('reporting runtime facts')) {
      phrasings.push({ system, facts: messages[0].content });
      return { content: 'Échec : le service ne répond pas, rien n’a été relancé.' };
    }
    return answer({ action: 'blocked', summary: 'The provider is unavailable.' });
  } };
  await superviseObjective(session, 'Requested action', { failures: [failure] }, { runId: 'run', state: state() });
  const notices = session.agentEvents.filter((event) => event.type === 'assistant_message' && event.origin === 'objective_supervisor');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].payload.content, 'Échec : le service ne répond pas, rien n’a été relancé.');
  assert.match(phrasings[0].system, /reply language: fr-FR/);
  assert.match(phrasings[0].facts, /Diagnosis: The provider is unavailable\./);
});

test('successful execution can lead to an autonomous read-only verification tail', async () => {
  const { session, task } = fixture();
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [{ ...task, status: 'pending' }] } }));
  dispatchAgentEvent(session, createAgentEvent('approval.granted', { runId: 'run', payload: { scope: 'run', runId: 'run', planRevision: 0, status: 'approved' } }));
  let assessments = 0; const operations = [];
  session.llm = { completeWithTools: async ({ system }) => {
    if (!system.includes('scheduler checkpoint')) return { content: 'Done.' };
    assessments++;
    if (assessments > 1) return answer({ action: 'complete', summary: 'Requested target verified' });
    const proposal = followUp('example.inspect', 'inspect'); delete proposal.replaceTaskId;
    return answer(proposal);
  } };
  const outcome = await runRuntimeAgenticWorkflow({}, session, 'Act and verify the requested target', { runId: 'run', signal: AbortSignal.timeout(3000), dispatcherPollIntervalMs: 1,
    callTool: async (_pool, _server, tool, args) => {
      if (tool === 'agent_execute') { operations.push(args.operation); return { accepted: true, jobId: args.operation }; }
      return { status: 'succeeded', terminal: true, result: { status: 'succeeded', ...(args.jobId === 'inspect' ? { verification: { status: 'verified' } } : {}) } };
    } });
  assert.equal(outcome.ok, true, JSON.stringify({ operations, outcome, plan: session.headlessPlan, events: session.agentEvents.filter((event) => ['assistant_message', 'run_error', 'runtime_log', 'plan.revision_changed'].includes(event.type)) })); assert.deepEqual(operations, ['act', 'inspect']);
  assert.equal(session.headlessPlan[0].id, 'first');
  assert.equal(session.agentEvents.some((event) => event.type === 'approval.requested' && event.payload.planRevision === 1), false);
});

test('run task budget is shared across adaptive plan revisions', async () => {
  const { session, task } = fixture();
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [{ ...task, status: 'pending' }] } }));
  dispatchAgentEvent(session, createAgentEvent('approval.granted', { runId: 'run', payload: { scope: 'run', runId: 'run', planRevision: 0, status: 'approved' } }));
  session.llm = { completeWithTools: async ({ system }) => {
    if (!system.includes('scheduler checkpoint')) return { content: 'Budget stopped execution.' };
    const proposal = followUp('example.inspect', 'inspect'); delete proposal.replaceTaskId; return answer(proposal);
  } };
  let executions = 0;
  const outcome = await runRuntimeAgenticWorkflow({}, session, 'Act and verify', { runId: 'run', budgets: { maxTasks: 1 }, signal: AbortSignal.timeout(3000), dispatcherPollIntervalMs: 1,
    callTool: async (_pool, _server, tool) => {
      if (tool === 'agent_execute') { executions++; return { accepted: true, jobId: 'first' }; }
      return { status: 'succeeded', terminal: true, result: { status: 'succeeded' } };
    } });
  assert.equal(outcome.ok, false); assert.equal(executions, 1);
  assert.equal(outcome.result.budgetExceeded, true);
});

test('diagnostics cannot read a job owned by another run or server', async () => {
  const { session } = fixture();
  session.mcp.service.tools.find((item) => item.name === 'agent_status').inputSchema = { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] };
  let turn = 0;
  session.llm = { completeWithTools: async () => ++turn === 1
    ? { tool_calls: [{ id: 'foreign', function: { name: 'service__agent_status', arguments: '{"jobId":"foreign-job"}' } }] }
    : answer({ action: 'blocked', summary: 'No evidence for this run' }) };
  const result = await investigateRun(session, {}, { runId: 'run', callTool: async () => assert.fail('cross-run read') });
  assert.equal(result.degraded, true);
});


test('a model explanation followed by one JSON fence is parsed; ambiguous decisions are refused', () => {
  assert.deepEqual(parseSupervisorDecision('The contract rejects the field.\n```json\n{"action":"retry","arguments":{"target":"requested"}}\n```'),
    { action: 'retry', arguments: { target: 'requested' } });
  assert.throws(() => parseSupervisorDecision('```json\n{"action":"retry"}\n```\n```json\n{"action":"complete"}\n```'), /ambiguous/);
  assert.throws(() => parseSupervisorDecision('Just run another tool.'), /missing/);
});

test('multiple failed tasks retain pre-execution evidence across plan revisions', async () => {
  const { session, task } = fixture();
  const initial = ['first', 'second'].map((id) => ({ ...task, id, status: 'pending', arguments: { target: id } }));
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: initial } }));
  dispatchAgentEvent(session, createAgentEvent('approval.granted', { runId: 'run', payload: { scope: 'run', runId: 'run', planRevision: 0, status: 'approved' } }));
  const operations = [];
  session.llm = { completeWithTools: async ({ system, messages }) => {
    if (!system.includes('scheduler checkpoint')) return { content: 'Follow-up.' };
    const facts = JSON.parse(JSON.parse(messages[0].content).facts);
    assert.equal(facts.rejectedBeforeExecution, true);
    const proposal = followUp('example.inspect', 'inspect');
    proposal.replaceTaskId = facts.task.id;
    proposal.tasks[0].arguments = { target: facts.arguments.target };
    return answer(proposal);
  } };
  const outcome = await runRuntimeAgenticWorkflow({}, session, 'Check both requested targets', { runId: 'run', signal: AbortSignal.timeout(3000), dispatcherPollIntervalMs: 1,
    callTool: async (_pool, _server, tool, args) => {
      if (tool === 'agent_execute') {
        operations.push([args.operation, args.arguments.target]);
        return args.operation === 'act' ? { accepted: false, error: 'provider_unavailable' } : { accepted: true, jobId: args.arguments.target };
      }
      return { status: 'succeeded', terminal: true, result: { status: 'succeeded', verification: { status: 'verified' } } };
    } });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(operations.filter(([op]) => op === 'act').length, 2);
  assert.deepEqual(operations.filter(([op]) => op === 'inspect').map(([, target]) => target).sort(), ['first', 'second']);
});
