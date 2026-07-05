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
    { step: 1, id: 'template-a', description: 'Build template A', status: 'pending', dependsOn: [] },
    { step: 2, id: 'template-b', description: 'Build template B', status: 'pending', dependsOn: [] },
  ];
}

function latencyAgent() {
  return {
    async invoke() {
      await new Promise((resolve) => setTimeout(resolve, SIMULATED_BUILD_LATENCY_MS));
      return { response: 'done' };
    },
  };
}

async function timedRun(concurrency, runId) {
  const session = { activities: {}, headlessPlan: buildTwoTemplatePlan() };
  const startedAt = Date.now();
  const result = await runRuntimeParallelPlan(latencyAgent(), session, 'Build 2 templates', {
    runId,
    timeoutMs: 10_000,
    maxTurns: 1,
    concurrency,
  });
  return { result, durationMs: Date.now() - startedAt };
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
