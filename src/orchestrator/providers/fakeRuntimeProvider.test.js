import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeRuntimeProvider } from './fakeRuntimeProvider.js';
import {
  RUNTIME_PROTOCOL_VERSION,
  RuntimeProviderUnavailableError,
  assertRuntimeDescription,
  assertRuntimeProvider,
} from './runtimeProvider.js';

function echoProvider(options) {
  const provider = createFakeRuntimeProvider(options);
  assertRuntimeProvider(provider);
  return provider;
}

async function waitForStatus(provider, runId, predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await provider.status(runId);
    if (predicate(status.status)) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  }
  throw new Error(`run ${runId} did not reach the expected status in time`);
}

test('discovery exposes the declared capabilities (Test 1)', async () => {
  const provider = echoProvider({ capabilities: [{ name: 'agent.echo', operations: ['run'] }] });

  const description = assertRuntimeDescription(await provider.describe());
  assert.equal(description.runtime, 'fake');
  assert.equal(description.protocolVersion, RUNTIME_PROTOCOL_VERSION);
  assert.equal(description.health, 'available');

  assert.deepEqual(
    await provider.discoverCapabilities(),
    [{ name: 'agent.echo', operations: ['run'] }],
  );
});

test('execute returns a runId and reaches completed (Test 2)', async () => {
  const provider = echoProvider();

  const run = await provider.execute({ objective: 'echo' });
  assert.equal(run.status, 'running');
  assert.ok(run.runId);

  const status = await waitForStatus(provider, run.runId, (value) => value === 'completed');
  assert.equal(status.status, 'completed');
});

test('subscribe replays and streams the run events (Test 3)', async () => {
  const provider = echoProvider();

  const run = await provider.execute({ objective: 'echo' });
  const events = [];
  const unsubscribe = provider.subscribe(run.runId, (event) => events.push(event));

  await waitForStatus(provider, run.runId, (value) => value === 'completed');

  const types = events.map((event) => event.type);
  assert.ok(types.includes('run_started'), 'replayed run_started');
  assert.ok(types.includes('tool_finished'), 'replayed tool_finished');
  assert.ok(types.includes('run_completed'), 'streamed run_completed');
  unsubscribe();
});

test('cancel stops the run and emits run_cancelled (Test 4)', async () => {
  const provider = echoProvider({ autoCompleteMs: 50 });

  const run = await provider.execute({ objective: 'echo' });
  const events = [];
  provider.subscribe(run.runId, (event) => events.push(event));

  await provider.cancel(run.runId);
  const status = await provider.status(run.runId);
  assert.equal(status.status, 'cancelled');
  assert.ok(events.some((event) => event.type === 'run_cancelled'));
});

test('a down provider reports unavailable and rejects execution (Test 5)', async () => {
  const provider = echoProvider({ available: false });

  const description = await provider.describe();
  assert.equal(description.health, 'unavailable');

  await assert.rejects(() => provider.discoverCapabilities(), RuntimeProviderUnavailableError);
  await assert.rejects(() => provider.execute({ objective: 'echo' }), RuntimeProviderUnavailableError);
});

test('concurrent runs are independent (Test 6)', async () => {
  const provider = echoProvider();

  const [a, b, c] = await Promise.all([
    provider.execute({ objective: 'A' }),
    provider.execute({ objective: 'B' }),
    provider.execute({ objective: 'C' }),
  ]);

  const runIds = [a.runId, b.runId, c.runId];
  assert.equal(new Set(runIds).size, 3, 'three distinct run ids');

  const statuses = await Promise.all(
    runIds.map((runId) => waitForStatus(provider, runId, (value) => value === 'completed')),
  );
  assert.deepEqual(
    statuses.map((status) => status.status),
    ['completed', 'completed', 'completed'],
  );
});

test('a provider with requireApproval waits for approve() before completing (Test 7)', async () => {
  const provider = echoProvider({ requireApproval: true });

  const run = await provider.execute({ objective: 'echo' });
  assert.equal(run.status, 'waiting_approval');

  const events = [];
  provider.subscribe(run.runId, (event) => events.push(event));
  assert.ok(events.some((event) => event.type === 'approval_required'), 'the proposal was emitted');
  assert.ok(!events.some((event) => event.type === 'run_completed'), 'nothing completes before approval');

  await provider.approve(run.runId, { approved: true, scope: ['echo'] });
  const status = await waitForStatus(provider, run.runId, (value) => value === 'completed');
  assert.equal(status.status, 'completed');
  assert.ok(events.some((event) => event.type === 'run_completed'));
});

test('denying the HITL approval cancels the run', async () => {
  const provider = echoProvider({ requireApproval: true });

  const run = await provider.execute({ objective: 'echo' });
  await provider.approve(run.runId, { approved: false, reason: 'refused' });

  const status = await provider.status(run.runId);
  assert.equal(status.status, 'cancelled');
});

test('per-capability HITL: a mutating capability waits for approve(), a read-only one does not', async () => {
  const provider = echoProvider({
    capabilities: [
      { name: 'agent.review', operations: ['run'] },
      { name: 'agent.research', operations: ['run'], mutationClass: 'ingest' },
    ],
  });

  const readRun = await provider.execute({ capability: 'agent.review', objective: 'audit' });
  const readStatus = await waitForStatus(provider, readRun.runId, (value) => value === 'completed');
  assert.equal(readStatus.status, 'completed');

  const mutatingRun = await provider.execute({ capability: 'agent.research', objective: 'research' });
  assert.equal(mutatingRun.status, 'waiting_approval');
  const events = [];
  provider.subscribe(mutatingRun.runId, (event) => events.push(event));
  const approval = events.find((event) => event.type === 'approval_required');
  assert.equal(approval.proposal.mutations[0].kind, 'ingest', 'the announced class matches the declared mutationClass');

  await provider.approve(mutatingRun.runId, { approved: true, scope: ['ingest'] });
  const final = await waitForStatus(provider, mutatingRun.runId, (value) => value === 'completed');
  assert.equal(final.status, 'completed');
});

test("the 'plan' operation is a dry-run and never pauses, even on a mutating capability", async () => {
  const provider = echoProvider({
    capabilities: [{ name: 'agent.plan', operations: ['plan', 'run'], defaultRequiresApproval: true }],
  });

  const dryRun = await provider.execute({ capability: 'agent.plan', operation: 'plan', objective: 'propose' });
  const dryStatus = await waitForStatus(provider, dryRun.runId, (value) => value === 'completed');
  assert.equal(dryStatus.status, 'completed', 'plan completes without approval');

  const liveRun = await provider.execute({ capability: 'agent.plan', operation: 'run', objective: 'propose' });
  assert.equal(liveRun.status, 'waiting_approval', 'run pauses for approval');
  await provider.approve(liveRun.runId, { approved: true });
  const final = await waitForStatus(provider, liveRun.runId, (value) => value === 'completed');
  assert.equal(final.status, 'completed');
});

test('fake provider carries a proposal in the structured result, like the gateway', async () => {
  const proposal = {
    capability: 'knowledge.update',
    operation: 'ingest',
    objective: 'ingest the pending raw sources',
    reason: 'deterministic E2E',
  };
  const provider = createFakeRuntimeProvider({
    capabilities: [{ name: 'agent.proposal-test', operations: ['run'] }],
    proposal,
  });
  const run = await provider.execute({ capability: 'agent.proposal-test', operation: 'run', objective: 'propose' });
  const status = await waitForStatus(provider, run.runId, (value) => value === 'completed');
  assert.deepEqual(status.result.planExpansionRequest, proposal);
});

test('fake provider without a proposal keeps a plain result', async () => {
  const provider = createFakeRuntimeProvider({ capabilities: [{ name: 'agent.echo', operations: ['run'] }] });
  const run = await provider.execute({ capability: 'agent.echo', operation: 'run', objective: 'echo' });
  const status = await waitForStatus(provider, run.runId, (value) => value === 'completed');
  assert.equal(status.result.planExpansionRequest, undefined);
  assert.equal(typeof status.result.content, 'string');
});
