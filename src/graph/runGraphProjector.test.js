import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentEvent } from '../core/agentEvents.js';
import { projectWorkflow } from '../core/workflow.js';

function sampleEvents() {
  return [
    createAgentEvent('run_started', { runId: 'run-graph', payload: { input: 'Run graph' } }),
    createAgentEvent('task_group.created', {
      runId: 'run-graph',
      payload: { group: { id: 'ingest', label: 'Ingest group' } },
    }),
    createAgentEvent('task.created', {
      runId: 'run-graph',
      taskId: 'run-graph:ingest',
      payload: {
        task: {
          id: 'run-graph:ingest',
          label: 'Ingest',
          description: 'Ingest',
          status: 'running',
          groupId: 'ingest',
          requiredCapability: 'knowledge.update',
          operation: 'ingest',
          dependsOn: [],
          outputRefs: [],
        },
      },
    }),
    createAgentEvent('task.created', {
      runId: 'run-graph',
      taskId: 'run-graph:apply',
      payload: {
        task: {
          id: 'run-graph:apply',
          label: 'Apply',
          description: 'Apply',
          status: 'pending',
          dependsOnGroup: 'ingest',
          barrier: true,
          requiredCapability: 'knowledge.update',
          operation: 'ingest_apply',
          dependsOn: ['run-graph:ingest'],
          outputRefs: [],
        },
      },
    }),
    createAgentEvent('task.assigned', {
      runId: 'run-graph',
      taskId: 'run-graph:ingest',
      payload: {
        taskId: 'run-graph:ingest',
        attemptId: 'attempt-1',
        assignment: { agentInstanceId: 'production-main' },
      },
    }),
    createAgentEvent('task.started', {
      runId: 'run-graph',
      taskId: 'run-graph:ingest',
      payload: { taskId: 'run-graph:ingest', attemptId: 'attempt-1', jobId: 'job-1' },
    }),
    createAgentEvent('task.result_returned', {
      runId: 'run-graph',
      taskId: 'run-graph:ingest',
      payload: { result: { attemptId: 'attempt-1', status: 'succeeded', outputRefs: [{ type: 'file', ref: 'out.json' }] } },
    }),
    createAgentEvent('plan.revision_changed', {
      runId: 'run-graph',
      payload: { runId: 'run-graph', previousRevision: 1, planRevision: 2, taskIds: ['run-graph:ingest'] },
    }),
  ];
}

test('run graph snapshot includes task groups, barrier, agent, assignment, attempt, result and expansion', () => {
  const workflow = projectWorkflow({
    status: 'running',
    runId: 'run-graph',
    plan: [
      { id: 'run-graph:ingest', description: 'Ingest', status: 'running', groupId: 'ingest', requiredCapability: 'knowledge.update', operation: 'ingest', dependsOn: [] },
      { id: 'run-graph:apply', description: 'Apply', status: 'pending', dependsOnGroup: 'ingest', barrier: true, requiredCapability: 'knowledge.update', operation: 'ingest_apply', dependsOn: ['run-graph:ingest'] },
    ],
    activities: [],
    queue: [],
    approvals: [],
  }, sampleEvents());

  const types = new Set(workflow.graph.nodes.map((node) => node.type));
  for (const type of ['task_group', 'barrier', 'agent_instance', 'assignment', 'attempt', 'result', 'plan_expansion']) {
    assert.ok(types.has(type), `missing graph node type ${type}`);
  }
  assert.ok(workflow.graph.visibleNodes.length <= 18);
  assert.ok(workflow.graph.nodes.find((node) => node.id === 'task:run-graph:ingest')?.tooltip.includes('Capacite : knowledge.update'));
});

test('run graph replay from the same events is deterministic', () => {
  const state = {
    status: 'running',
    runId: 'run-graph',
    plan: [
      { id: 'run-graph:ingest', description: 'Ingest', status: 'running', groupId: 'ingest', requiredCapability: 'knowledge.update', operation: 'ingest', dependsOn: [] },
    ],
    activities: [],
    queue: [],
    approvals: [],
  };
  const first = projectWorkflow(state, sampleEvents()).graph;
  const second = projectWorkflow(state, sampleEvents()).graph;

  assert.deepEqual(second, first);
});
