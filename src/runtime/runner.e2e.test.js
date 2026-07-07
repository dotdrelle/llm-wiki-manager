import assert from 'node:assert/strict';
import test from 'node:test';
import { runRuntimeParallelPlan } from './runner.js';

// Regression guard for plan-0.11.4-stabilisation.md §3: build de 2 templates
// en séquentiel -> T1, en multi-agent -> T2, assert T2 < 0.65*T1. Exercises
// the scheduler (runRuntimeParallelPlan) directly with mocked, fixed-latency
// tasks — it proves the scheduler itself parallelizes ready tasks, not that a
// real llm-wiki build/provider round-trip shows the same margin.
const SIMULATED_BUILD_LATENCY_MS = 150;
const MAX_PARALLEL_TO_SEQUENTIAL_RATIO = 0.65;

function buildTwoTemplatePlan() {
  return [
    plannedBuildTask(1, 'template-a'),
    plannedBuildTask(2, 'template-b'),
  ];
}

async function timedRun(concurrency, runId) {
  const jobs = new Map();
  const session = {
    workspace: 'demo-workspace',
    activities: {},
    headlessPlan: buildTwoTemplatePlan(),
    mcp: {
      production: {
        status: 'connected',
        tools: [{ name: 'agent_execute' }, { name: 'agent_status' }, { name: 'agent_cancel' }],
      },
    },
    agentRegistrySnapshot: [productionAgent()],
    wikircConfig: { capabilityRouting: {} },
  };
  const callTool = async (_mcp, _serverName, toolName, args) => {
    if (toolName === 'agent_execute') {
      const jobId = `job-${args.taskId}`;
      jobs.set(jobId, { jobId, taskId: args.taskId, startedAt: Date.now() });
      return toolResult({ accepted: true, jobId, status: 'queued' });
    }
    if (toolName === 'agent_status') {
      const job = jobs.get(args.jobId);
      const done = Date.now() - job.startedAt >= SIMULATED_BUILD_LATENCY_MS;
      return toolResult({
        jobId: job.jobId,
        taskId: job.taskId,
        operation: 'build',
        status: done ? 'done' : 'running',
        progress: { percent: done ? 100 : 50 },
        ...(done ? { result: { status: 'succeeded', outputRefs: [], metrics: { durationMs: SIMULATED_BUILD_LATENCY_MS } } } : {}),
      });
    }
    if (toolName === 'agent_cancel') return toolResult({ ok: true });
    throw new Error(`unexpected tool: ${toolName}`);
  };
  const startedAt = Date.now();
  const result = await runRuntimeParallelPlan({ invoke: async () => assert.fail('child Donna loop must not run') }, session, 'Build 2 templates', {
    runId,
    timeoutMs: 10_000,
    maxTurns: 1,
    concurrency,
    callTool,
    dispatcherPollIntervalMs: 5,
  });
  return { result, durationMs: Date.now() - startedAt };
}

function plannedBuildTask(step, id) {
  return {
    step,
    id,
    label: `Build ${id}`,
    description: `Build ${id}`,
    status: 'pending',
    dependsOn: [],
    requiredCapability: 'document.build',
    operation: 'build',
    arguments: { templates: [`${id}.md`] },
    parallelizable: true,
    inputRefs: [],
    expectedOutputRefs: [],
    locks: [],
    requiresApproval: false,
    idempotencyKey: 'test-idempotency-key',
    progressWeight: 1,
    outputRefs: [],
  };
}

function productionAgent() {
  return {
    serverName: 'production',
    agentInstanceId: 'production-main',
    health: 'available',
    description: {
      contractVersion: '1',
      agentType: 'production',
      agentInstanceId: 'production-main',
      displayName: 'Production',
      capabilities: [{
        id: 'document.build',
        version: '1',
        description: 'Build documents',
        inputSchema: { type: 'object', additionalProperties: true },
        outputSchema: { type: 'object', additionalProperties: true },
        supportedOperations: ['build'],
      }],
      orchestration: {
        canPlan: true,
        canExpandPlan: false,
        canExecute: true,
        canCancel: true,
        canResume: false,
        supportsIdempotency: false,
        supportsParallelWorkers: true,
      },
      limits: { recommendedConcurrency: 2, maxConcurrency: 2, maxTaskDurationMs: 10_000 },
      health: { status: 'available' },
    },
  };
}

function toolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

test('multi-agent scheduler beats sequential on 2 independent build tasks by the required margin (plan 0.11.4 §3 guard)', async () => {
  const { result: sequentialResult, durationMs: sequentialDurationMs } = await timedRun(1, 'e2e-accel-sequential');
  const { result: parallelResult, durationMs: parallelDurationMs } = await timedRun(2, 'e2e-accel-parallel');

  assert.equal(sequentialResult.ok, true);
  assert.equal(parallelResult.ok, true);
  const thresholdMs = MAX_PARALLEL_TO_SEQUENTIAL_RATIO * sequentialDurationMs;
  assert.ok(
    parallelDurationMs < thresholdMs,
    `expected multi-agent duration (${parallelDurationMs}ms) under ${MAX_PARALLEL_TO_SEQUENTIAL_RATIO * 100}% of sequential duration (${sequentialDurationMs}ms, threshold ${thresholdMs}ms)`,
  );
});
