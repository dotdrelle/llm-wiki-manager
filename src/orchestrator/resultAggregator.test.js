import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { accept } from './resultAggregator.js';

test('resultAggregator expands a plan after a task result and rewires insertion after the task', async () => {
  const session = sessionWithPlan();
  session.approvals = [{ id: 'approval-run', scope: 'run', status: 'approved', runId: 'run-expansion' }];
  const calls = [];

  const result = await accept(taskResultWithExpansion(), {
    session,
    runId: 'run-expansion',
    task: session.headlessPlan[0],
    assignment: { agentInstanceId: 'production-main', serverName: 'production' },
    registry: expansionRegistry(),
    callTool: async (_mcp, serverName, toolName, args) => {
      calls.push({ serverName, toolName, args });
      assert.equal(serverName, 'production');
      assert.equal(toolName, 'agent_plan');
      return expansionFragment();
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.expansion.ok, true);
  assert.deepEqual(calls.map((call) => call.args.capability), ['document.build']);
  const plan = Object.fromEntries(session.headlessPlan.map((task) => [task.id, task]));
  assert.deepEqual(plan['run-expansion:build-x'].dependsOn, ['run-expansion:a']);
  assert.deepEqual(plan['run-expansion:build-y'].dependsOn, ['run-expansion:build-x']);
  assert.deepEqual(plan['run-expansion:b'].dependsOn, ['run-expansion:build-y']);
  assert.equal(plan['run-expansion:build-x'].status, 'pending');
  assert.equal(session.planRevision, 1);
});

test('resultAggregator marks expanded tasks waiting_approval when approval is not covered', async () => {
  const session = sessionWithPlan();

  const result = await accept(taskResultWithExpansion(), {
    session,
    runId: 'run-expansion',
    task: session.headlessPlan[0],
    assignment: { agentInstanceId: 'production-main', serverName: 'production' },
    registry: expansionRegistry(),
    callTool: async () => expansionFragment(),
  });

  assert.equal(result.expansion.ok, true);
  const created = session.headlessPlan.filter((task) => ['run-expansion:build-x', 'run-expansion:build-y'].includes(task.id));
  assert.deepEqual(created.map((task) => task.status), ['waiting_approval', 'waiting_approval']);
});

test('resultAggregator rejects an expansion with an unknown capability and preserves task success', async () => {
  const session = sessionWithPlan();

  const result = await accept({
    ok: true,
    taskId: 'run-expansion:a',
    status: 'succeeded',
    outputRefs: [],
    planExpansionRequest: {
      capability: 'unknown.capability',
      operation: 'expand',
      arguments: {},
      insertAfterTasks: ['run-expansion:a'],
    },
  }, {
    session,
    runId: 'run-expansion',
    task: session.headlessPlan[0],
    assignment: { agentInstanceId: 'production-main', serverName: 'production' },
    registry: expansionRegistry(),
    callTool: async () => assert.fail('agent_plan must not be called for an unknown capability'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.expansion.ok, false);
  assert.equal(result.expansion.errors[0].code, 'capability_unavailable');
  assert.deepEqual(session.headlessPlan.map((task) => task.id), ['run-expansion:a', 'run-expansion:b']);
  assert.equal(session.headlessPlan[0].status, 'done');
  assert.ok(session.agentEvents.some((event) => event.type === 'plan.rejected'));
});

function sessionWithPlan() {
  const session = {
    mcp: {
      production: {
        tools: [{ name: 'agent_plan' }],
      },
    },
    agentEvents: [],
    activities: {},
    workspace: 'docs',
    headlessPlan: [
      {
        id: 'run-expansion:a',
        step: 1,
        label: 'Task A',
        description: 'Task A',
        status: 'running',
        dependsOn: [],
        outputRefs: [],
      },
      {
        id: 'run-expansion:b',
        step: 2,
        label: 'Task B',
        description: 'Task B',
        status: 'pending',
        dependsOn: ['run-expansion:a'],
        outputRefs: [],
      },
    ],
  };
  dispatchAgentEvent(session, createAgentEvent('plan_set', {
    origin: 'test',
    runId: 'run-expansion',
    payload: { steps: session.headlessPlan, planRevision: 0 },
  }));
  session.agentEvents = [];
  return session;
}

function taskResultWithExpansion() {
  return {
    ok: true,
    taskId: 'run-expansion:a',
    status: 'succeeded',
    outputRefs: [{ type: 'file', ref: 'out/a.json' }],
    planExpansionRequest: {
      capability: 'document.build',
      operation: 'build',
      objective: 'Build downstream generated documents.',
      arguments: { templates: ['templates/x.md'] },
      insertAfterTasks: ['run-expansion:a'],
    },
  };
}

function expansionFragment() {
  return {
    contractVersion: '1',
    agentInstanceId: 'production-main',
    capability: 'document.build',
    summary: {
      label: 'Build generated documents',
      initialSynthesis: ['Build two generated documents.'],
      estimatedTasks: 2,
    },
    groups: [{ id: 'build', label: 'Build', recommendedConcurrency: 1 }],
    tasks: [
      plannedBuildTask('build-x', []),
      plannedBuildTask('build-y', ['build-x']),
    ],
    expectedOutputs: [{ type: 'file', ref: 'deliverables/y.md' }],
  };
}

function plannedBuildTask(id, dependsOn) {
  return {
    id,
    label: `Build ${id}`,
    requiredCapability: 'document.build',
    operation: 'build',
    arguments: { templates: [`templates/${id}.md`] },
    groupId: 'build',
    dependsOn,
    parallelizable: true,
    inputRefs: [{ type: 'file', ref: `templates/${id}.md` }],
    expectedOutputRefs: [{ type: 'file', ref: `deliverables/${id}.md` }],
    locks: [`deliverable:${id}.md`],
    requiresApproval: true,
    idempotencyKey: `idem-${id}`,
    progressWeight: 1,
  };
}

function expansionRegistry() {
  return {
    providersFor(capability) {
      if (capability !== 'document.build') return [];
      return [{
        agentInstanceId: 'production-main',
        serverName: 'production',
        health: 'available',
        capability: {
          id: 'document.build',
          version: '1',
          description: 'Build documents',
          inputSchema: {
            type: 'object',
            required: ['templates'],
            additionalProperties: true,
            properties: {
              templates: { type: 'array', items: { type: 'string' } },
            },
          },
          outputSchema: {},
          supportedOperations: ['build'],
          mutationClass: 'workspace',
          defaultRequiresApproval: true,
        },
        description: { contractVersion: '1' },
      }];
    },
    isCompatible(contractVersion) {
      return String(contractVersion) === '1';
    },
  };
}
