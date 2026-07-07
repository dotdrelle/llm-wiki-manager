import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { assign } from './assignmentManager.js';
import { scheduleRetry } from './attemptManager.js';

test('assignment selects Commercial when CME is unavailable for the capability', async () => {
  const assignment = await assign(retryTask(), {
    session: agentSession(),
    registry: retryRegistry({ cmeHealth: 'unavailable' }),
  });

  assert.equal(assignment.agentInstanceId, 'commercial-main');
  assert.equal(assignment.serverName, 'commercial');
});

test('attemptManager schedules retry on Commercial after retryable CME failure', async () => {
  const session = agentSession();
  session.headlessPlan = [retryTask({ status: 'failed' })];
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'test',
    runId: 'run-retry',
    payload: { steps: session.headlessPlan, planRevision: 0 },
  }));
  session.agentEvents = [];

  const retry = scheduleRetry(session.headlessPlan[0], retryableFailure(), {
    assignment: { agentInstanceId: 'cme-main', serverName: 'cme' },
    registry: retryRegistry(),
    session,
    runId: 'run-retry',
  });
  const assignment = await assign(session.headlessPlan[0], {
    session,
    registry: retryRegistry(),
  });

  assert.equal(retry.scheduled, true);
  assert.equal(retry.previousAgentInstanceId, 'cme-main');
  assert.equal(retry.newAgentInstanceId, 'commercial-main');
  assert.equal(session.headlessPlan[0].status, 'pending');
  assert.equal(session.headlessPlan[0].retryState.attempts, 2);
  assert.equal(assignment.agentInstanceId, 'commercial-main');
  assert.ok(session.agentEvents.some((event) => event.type === 'task.retry_scheduled'
    && event.payload.previousAgentInstanceId === 'cme-main'
    && event.payload.newAgentInstanceId === 'commercial-main'));
});

test('attemptManager does not fallback to an incompatible contract provider', () => {
  const session = agentSession();
  session.headlessPlan = [retryTask({ status: 'failed' })];

  const retry = scheduleRetry(session.headlessPlan[0], retryableFailure(), {
    assignment: { agentInstanceId: 'cme-main', serverName: 'cme' },
    registry: retryRegistry({ commercialContractVersion: '2' }),
    session,
    runId: 'run-retry',
  });

  assert.equal(retry.scheduled, false);
  assert.equal(retry.reason, 'no_compatible_fallback');
  assert.equal(session.headlessPlan[0].status, 'failed');
  assert.equal(session.agentEvents?.some((event) => event.type === 'task.retry_scheduled'), false);
});

function retryTask(overrides = {}) {
  return {
    id: 'run-retry:diagnose',
    step: 1,
    label: 'Diagnose',
    description: 'Diagnose',
    status: 'pending',
    dependsOn: [],
    requiredCapability: 'workspace.diagnose',
    operation: 'doctor',
    arguments: {},
    inputRefs: [],
    expectedOutputRefs: [{ type: 'file', ref: 'diagnostics.json' }],
    locks: [],
    requiresApproval: false,
    idempotencyKey: null,
    progressWeight: 1,
    retryPolicy: {
      maxAttempts: 2,
      retryableErrors: ['temporarily_unavailable'],
      allowAgentFallback: true,
    },
    ...overrides,
  };
}

function retryableFailure() {
  return {
    ok: false,
    taskId: 'run-retry:diagnose',
    result: {
      ok: false,
      taskId: 'run-retry:diagnose',
      agentInstanceId: 'cme-main',
      status: 'failed',
      error: {
        code: 'temporarily_unavailable',
        message: 'CME temporarily unavailable',
        retryable: true,
      },
    },
  };
}

function agentSession() {
  return {
    mcp: {},
    agentEvents: [],
    activities: {},
    agentRegistrySnapshot: [
      { agentInstanceId: 'cme-main', serverName: 'cme' },
      { agentInstanceId: 'commercial-main', serverName: 'commercial' },
    ],
  };
}

function retryRegistry({
  cmeHealth = 'available',
  commercialHealth = 'available',
  commercialContractVersion = '1',
} = {}) {
  const providers = [
    provider('cme-main', 'cme', cmeHealth, '1'),
    provider('commercial-main', 'commercial', commercialHealth, commercialContractVersion),
  ];
  return {
    providersFor(capability) {
      return capability === 'workspace.diagnose' ? providers : [];
    },
    isCompatible(contractVersion) {
      return String(contractVersion) === '1';
    },
  };
}

function provider(agentInstanceId, serverName, health, contractVersion) {
  return {
    agentInstanceId,
    serverName,
    health,
    capability: {
      id: 'workspace.diagnose',
      version: '1',
      description: 'Diagnose',
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: {},
      supportedOperations: ['doctor'],
    },
    description: {
      contractVersion,
      agentInstanceId,
    },
  };
}
