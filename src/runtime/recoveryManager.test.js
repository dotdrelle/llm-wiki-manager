import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentEvent } from '../core/agentEvents.js';
import { openRuntimeStore } from './store.js';
import { recoverActiveRuns } from './recoveryManager.js';

test('recoveryManager attaches a terminal active job through agent_status', async () => {
  const { store, root, runId, taskId } = storeWithActiveTask();
  const session = recoverySession();
  store.hydrateSession(session, { workspace: 'docs' });
  const statusCalls = [];

  try {
    const result = await recoverActiveRuns({
      store,
      session,
      workspace: 'docs',
      callTool: async (_mcp, serverName, toolName, args) => {
        statusCalls.push({ serverName, toolName, args });
        return {
          content: [{ type: 'text', text: JSON.stringify({
            jobId: args.jobId,
            taskId,
            status: 'done',
            result: {
              status: 'succeeded',
              outputRefs: [{ type: 'file', ref: 'deliverables/a.md' }],
              metrics: { durationMs: 12 },
            },
          }) }],
        };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(statusCalls, [{ serverName: 'production', toolName: 'agent_status', args: { jobId: 'job-1' } }]);
    assert.equal(result.recovered[0].taskId, taskId);
    assert.equal(store.listTasks({ runId })[0].status, 'done');
    assert.equal(store.getTaskResult({ taskId }).status, 'succeeded');
    assert.deepEqual(store.getTaskResult({ taskId }).outputRefs, [{ type: 'file', ref: 'deliverables/a.md' }]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recoveryManager requeues an active job by idempotencyKey when status is still running', async () => {
  const { store, root, runId, taskId } = storeWithActiveTask();
  const session = recoverySession();
  store.hydrateSession(session, { workspace: 'docs' });

  try {
    const result = await recoverActiveRuns({
      store,
      session,
      workspace: 'docs',
      callTool: async (_mcp, _serverName, _toolName, args) => ({
        content: [{ type: 'text', text: JSON.stringify({
          jobId: args.jobId,
          taskId,
          status: 'running',
          progress: { percent: 50 },
        }) }],
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.rescheduled[0].idempotencyKey, 'idem-a');
    assert.equal(store.listTasks({ runId })[0].status, 'pending');
    assert.ok(session.agentEvents.some((event) => event.type === 'plan_step_updated'
      && event.payload?.recovery?.idempotencyKey === 'idem-a'));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function storeWithActiveTask() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-manager-recovery-'));
  const stateDir = join(root, '.wiki', 'runtime');
  const store = openRuntimeStore({ stateDir });
  const runId = 'run-recovery';
  const taskId = 'run-recovery:build-a';
  const attemptId = `${taskId}:attempt-1`;
  for (const event of [
    createAgentEvent('run_started', {
      origin: 'runtime',
      runId,
      workspace: 'docs',
      payload: { input: 'build docs', workspace: 'docs' },
    }),
    createAgentEvent('task.created', {
      origin: 'plan_integrator',
      runId,
      taskId,
      workspace: 'docs',
      payload: { runId, task: plannedTask(taskId) },
    }),
    createAgentEvent('task.assigned', {
      origin: 'assignment_manager',
      runId,
      taskId,
      workspace: 'docs',
      payload: {
        runId,
        taskId,
        attemptId,
        assignment: { attemptId, agentInstanceId: 'production-main', agentId: 'production' },
      },
    }),
    createAgentEvent('task.started', {
      origin: 'dispatcher',
      runId,
      taskId,
      workspace: 'docs',
      payload: { runId, taskId, attemptId, jobId: 'job-1', startedAt: '2026-07-07T10:00:00.000Z' },
    }),
  ]) {
    store.persistEvent(event);
  }
  return { store, root, runId, taskId };
}

function plannedTask(id) {
  return {
    id,
    localId: 'build-a',
    label: 'Build A',
    description: 'Build A',
    requiredCapability: 'document.build',
    operation: 'build',
    arguments: { templates: ['a.md'] },
    groupId: null,
    dependsOn: [],
    inputRefs: [],
    expectedOutputRefs: [{ type: 'file', ref: 'deliverables/a.md' }],
    locks: ['workspace-write'],
    requiresApproval: false,
    idempotencyKey: 'idem-a',
    progressWeight: 1,
    status: 'running',
  };
}

function recoverySession() {
  return {
    workspace: 'docs',
    activities: {},
    mcp: {
      production: { tools: [{ name: 'agent_status' }] },
    },
    agentRegistrySnapshot: [{
      agentInstanceId: 'production-main',
      serverName: 'production',
      description: { agentType: 'production', contractVersion: '1' },
    }],
  };
}

test('recoveryManager fails unresolvable-capability tasks and interrupts the run', async () => {
  const { store, root, runId, taskId } = storeWithActiveTask();
  const session = recoverySession();
  // A registry that DOES know capabilities, but not the task's one: the plan
  // came from a hallucinated capability (the 0.12.1 incident) — re-attaching
  // it would recreate a forever-waiting queue on every boot.
  session.agentRegistrySnapshot = [{
    agentInstanceId: 'production-main',
    serverName: 'production',
    health: 'available',
    description: {
      agentType: 'production',
      contractVersion: '1',
      capabilities: [{ id: 'knowledge.pipeline', version: '1' }],
    },
  }];
  store.hydrateSession(session, { workspace: 'docs' });
  const statusCalls = [];

  try {
    const result = await recoverActiveRuns({
      store,
      session,
      workspace: 'docs',
      callTool: async (_mcp, serverName, toolName, args) => {
        statusCalls.push({ serverName, toolName, args });
        return { content: [{ type: 'text', text: '{}' }] };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.recovered.length, 0);
    assert.equal(result.rescheduled.length, 0);
    assert.equal(result.interrupted.length, 1);
    assert.match(result.interrupted[0].reason, /unresolvable capability: document\.build/);
    assert.deepEqual(statusCalls, [], 'no agent_status poll for an unresolvable task');
    assert.equal(store.listTasks({ runId })[0].status, 'failed');
    // The run must not come back as a zombie on the next boot.
    assert.deepEqual(store.listRecoverableRuns({ workspace: 'docs' }), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recoveryManager keeps recovering when the registry has no capability information', async () => {
  const { store, root, runId, taskId } = storeWithActiveTask();
  const session = recoverySession(); // snapshot without capability lists
  store.hydrateSession(session, { workspace: 'docs' });

  try {
    const result = await recoverActiveRuns({
      store,
      session,
      workspace: 'docs',
      callTool: async (_mcp, _serverName, _toolName, args) => ({
        content: [{ type: 'text', text: JSON.stringify({
          jobId: args.jobId,
          taskId,
          status: 'done',
          result: { status: 'succeeded', outputRefs: [], metrics: {} },
        }) }],
      }),
    });

    assert.equal(result.recovered.length, 1, 'uninformative registry must not block recovery');
    assert.equal(store.listTasks({ runId })[0].status, 'done');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
