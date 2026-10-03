import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { approvalCovered } from '../orchestrator/approvalPolicy.js';
import { failureDiagnostics, recoverFailedRun } from './failureRecovery.js';
import { runRuntimeAgenticWorkflow } from './runner.js';

function fixture({ started = false, response, extraPlan = [], error = 'invalid_arguments:unsupported_field:confirm' } = {}) {
  const capability = { id: 'communication.send-email', version: '1', description: 'Send one email',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'], additionalProperties: false },
    outputSchema: {}, supportedOperations: ['send'], mutationClass: 'external-target' };
  const provider = { agentInstanceId: 'connectors', serverName: 'connectors', health: 'available', capability,
    description: { contractVersion: '1', agentType: 'connectors', capabilities: [capability], limits: { recommendedConcurrency: 1, maxConcurrency: 1 } } };
  const registry = { providersFor: (id) => id === capability.id ? [provider] : [], isCompatible: () => true };
  const task = { id: 'send', label: 'Send the requested email', requiredCapability: capability.id, operation: 'send',
    arguments: { to: 'person@example.com', body: 'Hello' }, status: 'failed', idempotencyKey: 'original-send', locks: ['external:mail'], dependsOn: [],
    requiresApproval: true, approved: true, retryState: { attempts: 1 } };
  let calls = 0;
  const session = { workspace: 'demo', language: 'fr-FR', activities: {}, agentEvents: [], capabilityRegistry: registry,
    mcp: { connectors: { status: 'connected', tools: [{ name: 'agent_execute' }, { name: 'agent_status' }] } },
    llm: { async completeWithTools(request) { calls++; return { content: JSON.stringify(response ?? { action: 'retry', summary: 'Le champ confirm est refusé par le contrat.', arguments: task.arguments }) }; } } };
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [task, ...extraPlan] } }));
  const outcome = { ok: false, status: 'failed', error: { message: error }, jobId: started ? 'job' : null };
  Object.defineProperty(outcome, 'executionContext', { value: { rejectedBeforeExecution: !started, arguments: { ...task.arguments, confirm: true } } });
  return { session, provider, task, calls: () => calls, result: { failures: [{ taskId: 'send', assignment: { agentInstanceId: 'connectors' }, result: outcome }] } };
}

test('an injected unsupported field produces a validated replacement with a fresh approval, not a replay', async () => {
  const { session, task, result, calls } = fixture();
  const recovery = await recoverFailedRun(session, 'Send the email', result, { runId: 'run' });
  assert.equal(recovery.recovered, true, recovery.reason ?? JSON.stringify(session.agentEvents.at(-2)));
  assert.equal(calls(), 1);
  const retry = session.headlessPlan[0];
  assert.equal(retry.status, 'waiting_approval');
  assert.equal(retry.recoveryOf, 'send');
  assert.notEqual(retry.id, task.id);
  assert.notEqual(retry.idempotencyKey, task.idempotencyKey);
  assert.deepEqual(retry.arguments, task.arguments);
  assert.equal(retry.retryAssignment.agentInstanceId, 'connectors');
  assert.equal(approvalCovered(retry, [{ scope: 'run', runId: 'run', status: 'approved', planRevision: 0 }], { runId: 'run', planRevision: 1 }), false);
  assert.equal(approvalCovered(retry, [{ scope: 'run', runId: 'run', status: 'approved', planRevision: null }], { runId: 'run', planRevision: 1 }), false);
  assert.equal(approvalCovered(retry, [{ scope: 'run', runId: 'run', status: 'approved', planRevision: 1 }], { runId: 'run', planRevision: 1 }), true);
  assert.ok(session.agentEvents.some((event) => event.type === 'approval.requested'));
});

test('a started job, missing authorization or scope-widening correction is explained without scheduling', async () => {
  for (const options of [
    { started: true },
    { error: 'authentication_required' },
    { response: { action: 'retry', summary: 'Change recipient', arguments: { to: 'another@example.com', body: 'Hello' } } },
    { response: { action: 'retry', summary: 'Invalid correction', arguments: { to: 12, body: 'Hello' } } },
  ]) {
    const { session, result } = fixture(options);
    const before = structuredClone(session.headlessPlan);
    const recovery = await recoverFailedRun(session, 'Send the email', result, { runId: 'run' });
    assert.equal(recovery.recovered, false);
    assert.deepEqual(session.headlessPlan, before);
    assert.equal(session.agentEvents.some((event) => event.type === 'approval.requested'), false);
    assert.ok(session.agentEvents.some((event) => event.type === 'assistant_message'));
  }
});

test('recovery preserves completed output evidence and revives only skipped descendants', async () => {
  const { session, task, result } = fixture();
  const done = { ...task, id: 'done', status: 'done', outputRefs: ['proof.md'], result: { stats: { written: 1 } } };
  const child = { ...task, id: 'child', status: 'skipped', approved: undefined, dependsOn: ['send'], error: { code: 'dependency_failed' } };
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [done, task, child] } }));
  const beforeDone = structuredClone(session.headlessPlan[0]);
  assert.equal((await recoverFailedRun(session, 'Send the email', result, { runId: 'run' })).recovered, true);
  assert.deepEqual(session.headlessPlan[0], beforeDone);
  assert.equal(session.headlessPlan[2].status, 'waiting_approval');
  assert.deepEqual(session.headlessPlan[2].dependsOn, [session.headlessPlan[1].id]);
});

test('a second correction is refused and absent or malformed model responses degrade visibly', async () => {
  const { session, result } = fixture();
  session.headlessPlan[0].recoveryOf = 'earlier-send';
  assert.equal((await recoverFailedRun(session, 'Send', result, { runId: 'run' })).recovered, false);
  for (const llm of [null, { completeWithTools: async () => ({ content: 'invalid JSON' }) }]) {
    const f = fixture(); f.session.llm = llm;
    const recovery = await recoverFailedRun(f.session, 'Send', f.result, { runId: 'run' });
    assert.equal(recovery.recovered, false);
    assert.match(f.session.agentEvents.findLast((event) => event.type === 'assistant_message').payload.content, /diagnosis unavailable/i);
  }
});

test('credentials are excluded from diagnosis and redaction forbids retry', async () => {
  const { session, result } = fixture();
  result.failures[0].result.executionContext.arguments.accessToken = 'PRIVATE-TOKEN';
  session.llm.completeWithTools = async ({ messages, tools }) => {
    assert.deepEqual(tools, []);
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE-TOKEN/);
    return { content: JSON.stringify({ action: 'retry', summary: 'Argument defect', arguments: { to: 'person@example.com', body: 'Hello' } }) };
  };
  assert.equal((await recoverFailedRun(session, 'Send', result, { runId: 'run' })).recovered, false);
});

test('read-only diagnostics expose current errors and contracts without message content', () => {
  const { session } = fixture();
  session.headlessPlan[0].result = { agentInstanceId: 'connectors', error: { message: 'invalid_arguments:confirm' } };
  const diagnostics = failureDiagnostics(session, session.headlessPlan);
  assert.equal(diagnostics[0].error, 'invalid_arguments:confirm');
  assert.equal(diagnostics[0].inputSchema.additionalProperties, false);
  assert.deepEqual(diagnostics[0].argumentNames, ['to', 'body']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /person@example.com|Hello/);
});

test('a plan revision changed during diagnosis is never overwritten', async () => {
  const { session, result, task } = fixture();
  session.llm.completeWithTools = async () => {
    dispatchAgentEvent(session, createAgentEvent('plan.revision_changed', { runId: 'run', payload: { planRevision: 1, tasks: session.headlessPlan } }));
    return { content: JSON.stringify({ action: 'retry', summary: 'Argument defect', arguments: task.arguments }) };
  };
  const recovery = await recoverFailedRun(session, 'Send', result, { runId: 'run' });
  assert.equal(recovery.recovered, false);
  assert.equal(recovery.reason, 'plan changed during diagnosis');
  assert.equal(session.headlessPlan[0].id, 'send');
  assert.equal(session.agentEvents.some((event) => event.type === 'approval.requested'), false);
});

for (const secondFails of [false, true]) test(`the workflow waits for fresh approval and bounds recovery when the retry ${secondFails ? 'fails' : 'succeeds'}`, async () => {
  const { session, task } = fixture();
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: [{ ...task, status: 'pending' }] } }));
  dispatchAgentEvent(session, createAgentEvent('approval.granted', { runId: 'run', payload: { id: 'old-grant', scope: 'run', runId: 'run', planRevision: 0, status: 'approved' } }));
  let executions = 0;
  let diagnosisCalls = 0;
  let objectiveChecks = 0;
  let approved = false;
  // Simulate the old integration injecting confirm into a request rejected by
  // the agent. The correction must be distinguishable from the sent payload.
  session.headlessPlan[0].arguments = { ...task.arguments, confirm: true };
  // Keep the projection authoritative before the scheduler starts.
  dispatchAgentEvent(session, createAgentEvent('plan_set', { runId: 'run', payload: { planRevision: 0, steps: session.headlessPlan } }));
  session._onAgentEvent = (event) => {
    if (event.type === 'approval.requested' && event.payload.planRevision === 1) {
      assert.equal(executions, 1, 'nothing re-executes before human approval');
      setTimeout(() => { approved = true; dispatchAgentEvent(session, createAgentEvent('approval.granted', { runId: 'run', payload: { id: 'new-grant', scope: 'run', runId: 'run', planRevision: 1, status: 'approved' } })); }, 10);
    }
  };
  // Diagnosis asserts the exact wire request, including the rejected field.
  session.llm.completeWithTools = async ({ system, messages }) => {
    if (system.includes('diagnosing a failed execution')) {
      const facts = JSON.parse(JSON.parse(messages[0].content).facts);
      // The objective check after a success (the send is a mutation its agent
      // did not verify here) is a supervisor checkpoint, not a failure
      // diagnosis: it carries the evaluation and concludes the objective.
      if (facts.evaluation) {
        objectiveChecks++;
        return { content: JSON.stringify({ action: 'complete', summary: 'The email was accepted by the agent.' }) };
      }
      diagnosisCalls++;
      if (diagnosisCalls > 1) return { content: JSON.stringify({ action: secondFails ? 'blocked' : 'complete', summary: secondFails ? 'The correction also failed; intervention is required.' : 'Execution completed; no independent observation is available.' }) };
      assert.equal(facts.arguments.confirm, true);
      return { content: JSON.stringify({ action: 'retry', summary: 'The integration field confirm is unsupported.', arguments: task.arguments }) };
    }
    return { content: 'Task completed.' };
  };
  const outcome = await runRuntimeAgenticWorkflow({ invoke: async () => assert.fail('structured recovery must never execute prose tasks') }, session, 'Send email', {
    runId: 'run', signal: AbortSignal.timeout(3000), timeoutMs: 5000, dispatcherPollIntervalMs: 1, maxReplans: 4,
    callTool: async (_pool, _server, name, args) => {
      if (name === 'agent_execute') {
        executions++;
        if (executions === 1) return { accepted: false, error: 'invalid_arguments:unsupported_field:confirm' };
        assert.equal(approved, true);
        assert.equal(args.arguments.confirm, undefined);
        return secondFails ? { accepted: false, error: 'invalid_arguments:unsupported_field:body' } : { accepted: true, jobId: 'sent' };
      }
      return { status: 'succeeded', terminal: true, result: { status: 'succeeded' } };
    },
  });
  assert.equal(outcome.ok, !secondFails, JSON.stringify(session.agentEvents.filter(e => e.type === 'assistant_message')));
  if (!secondFails) assert.equal(outcome.evaluation.ok, true);
  assert.equal(executions, 2);
  assert.equal(diagnosisCalls, secondFails ? 2 : 1, 'one diagnosis per failure, the correction budget stays one');
  assert.equal(objectiveChecks, secondFails ? 0 : 1, 'a successful unverified mutation gets one objective check');
  assert.equal(session.agentEvents.some((event) => event.type === 'run_replanned'), false);
});
