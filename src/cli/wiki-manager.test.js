import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutorOnlyFragment,
  forwardRuntimeApproval,
  resolveExecutorArguments,
  resolvePreparedDelegationApproval,
} from './wiki-manager.js';

const COLLECT_CAPABILITY = {
  description: 'Collect content from an external connector source.',
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      maxMessages: { type: 'integer' },
      query: { type: 'string' },
    },
  },
};

test('executor-only capabilities receive one manager-authored executable task', () => {
  const fragment = buildExecutorOnlyFragment({
    objective: 'donne-moi mes derniers mails',
    workspace: 'juno',
    selection: {
      capability: 'external-source.collect',
      operation: 'collect',
      arguments: { maxMessages: 10 },
      provider: {
        serverName: 'connectors',
        agentInstanceId: 'connectors-1',
        description: {
          contractVersion: '1',
          orchestration: { canPlan: false, singleTaskOnly: true },
        },
        capability: {
          mutationClass: 'external-source',
          defaultRequiresApproval: true,
        },
      },
    },
  });

  assert.equal(fragment.agentInstanceId, 'connectors-1');
  assert.equal(fragment.tasks.length, 1);
  assert.equal(fragment.tasks[0].requiredCapability, 'external-source.collect');
  assert.equal(fragment.tasks[0].operation, 'collect');
  assert.deepEqual(fragment.tasks[0].arguments, { maxMessages: 10 });
  assert.deepEqual(fragment.tasks[0].locks, ['external-source.collect:juno']);
  assert.equal(fragment.tasks[0].requiresApproval, true);
  assert.equal(fragment.tasks[0].approvalClass, 'external-source');
  assert.match(fragment.tasks[0].idempotencyKey, /^[0-9a-f-]{36}$/);
});

test('generic argument extraction fills the executor task from the objective', async () => {
  const llm = {
    completeWithTools: async () => ({
      tool_calls: [{
        function: { name: 'set_task_arguments', arguments: JSON.stringify({ maxMessages: 10 }) },
      }],
    }),
  };
  const args = await resolveExecutorArguments({
    llm,
    objective: 'récupère les 10 derniers mails',
    capability: COLLECT_CAPABILITY,
  });
  assert.deepEqual(args, { maxMessages: 10 });
});

test('argument extraction falls back to a JSON-text completion', async () => {
  const llm = {
    completeWithTools: async ({ tools }) =>
      tools.length > 0 ? { content: '' } : { content: '{"query":"from:linkedin.com"}' },
  };
  const args = await resolveExecutorArguments({
    llm,
    objective: 'les mails de LinkedIn',
    capability: COLLECT_CAPABILITY,
  });
  assert.deepEqual(args, { query: 'from:linkedin.com' });
});

test('argument extraction stays agnostic and safe when it cannot extract', async () => {
  // No inputSchema → no extraction attempted at all.
  assert.deepEqual(
    await resolveExecutorArguments({ llm: { completeWithTools: async () => ({}) }, objective: 'x', capability: {} }),
    {},
  );
  // Provider/LLM failure degrades to the executor's own defaults, never throws.
  const throwing = { completeWithTools: async () => { throw new Error('gateway rejected tool_choice'); } };
  assert.deepEqual(
    await resolveExecutorArguments({ llm: throwing, objective: 'les 10 derniers mails', capability: COLLECT_CAPABILITY }),
    {},
  );
});

test('runtime approval bridge preserves the complete run-scoped grant', async () => {
  let forwarded = null;
  const request = {
    workspace: 'test4',
    workspaceId: 'test4',
    runId: 'run-1',
    scope: 'run',
    planRevision: 3,
    approvalClasses: ['mutation'],
  };

  const result = await forwardRuntimeApproval(async (workspace) => ({
    approvalManager: {
      approve(value) {
        assert.equal(workspace, 'test4');
        forwarded = value;
        return { approved: true };
      },
    },
  }), request);

  assert.deepEqual(forwarded, request);
  assert.deepEqual(result, { approved: true });
});

test('prepared delegation waits for explicit approval by default', () => {
  let calls = 0;
  const result = resolvePreparedDelegationApproval({
    runId: 'run-gated',
    approvalManager: {
      approve() {
        calls += 1;
      },
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, { approved: false, awaitingApproval: true });
});

test('prepared delegation only approves when autoApprove is explicitly true', () => {
  let forwarded = null;
  const result = resolvePreparedDelegationApproval({
    autoApprove: true,
    runId: 'run-headless',
    approvalManager: {
      approve(request) {
        forwarded = request;
        return { approved: true };
      },
    },
  });

  assert.deepEqual(forwarded, { scope: 'run', runId: 'run-headless' });
  assert.deepEqual(result, {
    approved: true,
    awaitingApproval: false,
    result: { approved: true },
  });
});
