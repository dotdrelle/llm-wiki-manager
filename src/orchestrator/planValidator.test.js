import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PlanValidationError,
  assertValidatedFragment,
  isValidatedFragment,
  validateFragment,
} from './planValidator.js';

function provider(capabilityId = 'knowledge.update', {
  operations = ['ingest'],
  health = 'available',
  contractVersion = '1',
  inputSchema = {
    type: 'object',
    required: ['inputs'],
    additionalProperties: true,
    properties: {
      inputs: { type: 'array', items: { type: 'string' } },
    },
  },
  mutation = true,
} = {}) {
  return {
    agentInstanceId: 'production-main',
    health,
    capability: {
      id: capabilityId,
      version: '1',
      description: capabilityId,
      inputSchema,
      outputSchema: {},
      supportedOperations: operations,
      ...(mutation ? { mutationClass: 'workspace', defaultRequiresApproval: true } : {}),
    },
    description: {
      contractVersion,
      agentType: 'production',
      agentInstanceId: 'production-main',
      displayName: 'Production',
      capabilities: [],
    },
  };
}

function registry(providers = [provider()]) {
  return {
    providersFor(capability) {
      const id = String(capability).split('@')[0];
      return providers.filter((item) => item.capability.id === id);
    },
    isCompatible(contractVersion) {
      return String(contractVersion) === '1';
    },
  };
}

function fragment(overrides = {}) {
  return {
    contractVersion: '1',
    agentInstanceId: 'production-main',
    capability: 'knowledge.update',
    summary: {
      label: 'Update knowledge',
      initialSynthesis: ['One source file will be ingested.'],
      estimatedTasks: 1,
    },
    groups: [{
      id: 'Ingest Group',
      label: 'Ingest sources',
      recommendedConcurrency: 2,
      progressWeight: 1,
    }],
    tasks: [{
      id: 'Ingest A',
      label: 'Ingest A',
      requiredCapability: 'knowledge.update',
      operation: 'ingest',
      arguments: { inputs: ['raw/untracked/a.md'] },
      groupId: 'Ingest Group',
      dependsOn: [],
      parallelizable: true,
      inputRefs: [{ type: 'file', ref: 'raw/untracked/a.md' }],
      expectedOutputRefs: [{ type: 'file', ref: '.wiki/ingest-plans/a.json' }],
      locks: ['workspace-write'],
      requiresApproval: true,
      idempotencyKey: 'idem-a',
      progressWeight: 1,
    }],
    expectedOutputs: [{ type: 'directory', ref: 'wiki' }],
    ...overrides,
  };
}

function firstErrorCode(result) {
  return result.errors[0]?.code;
}

test('planValidator normalizes a valid fragment and marks it as validated', () => {
  const result = validateFragment(fragment(), {
    registry: registry(),
    run: { plannerAgentInstanceId: 'production-main' },
    budgets: { maxTasks: 2, maxConcurrency: 2, maxDepth: 1, maxProgressWeight: 2 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.normalizedFragment.tasks[0].id, 'ingest-a');
  assert.equal(result.normalizedFragment.tasks[0].groupId, 'ingest-group');
  assert.equal(result.normalizedFragment.groups[0].id, 'ingest-group');
  assert.equal(isValidatedFragment(result.normalizedFragment), true);
  assert.equal(assertValidatedFragment(result.normalizedFragment), result.normalizedFragment);
});

test('planValidator rejects invalid contract shape', () => {
  const result = validateFragment(fragment({ extra: true }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'invalid_contract_shape');
});

test('planValidator rejects unsupported contract version', () => {
  const result = validateFragment(fragment({ contractVersion: '99' }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'unsupported_contract_version');
});

test('planValidator rejects agent instance mismatch', () => {
  const result = validateFragment(fragment(), {
    registry: registry(),
    run: { plannerAgentInstanceId: 'production-secondary' },
  });
  assert.equal(firstErrorCode(result), 'agent_instance_mismatch');
});

test('planValidator rejects estimated task mismatch', () => {
  const result = validateFragment(fragment({
    summary: {
      label: 'Update knowledge',
      initialSynthesis: [],
      estimatedTasks: 2,
    },
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'estimated_tasks_mismatch');
});

test('planValidator rejects duplicate normalized task ids', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    summary: { ...base.summary, estimatedTasks: 2 },
    tasks: [
      base.tasks[0],
      { ...base.tasks[0], id: 'ingest-a', label: 'Duplicate ingest' },
    ],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'duplicate_task_id');
});

test('planValidator rejects unknown task groups', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    tasks: [{ ...base.tasks[0], groupId: 'missing-group' }],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'unknown_group_id');
});

test('planValidator rejects unknown dependencies', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    tasks: [{ ...base.tasks[0], dependsOn: ['missing-task'] }],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'unknown_dependency');
});

test('planValidator rejects self dependencies', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    tasks: [{ ...base.tasks[0], dependsOn: ['Ingest A'] }],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'self_dependency');
});

test('planValidator rejects dependency cycles with Kahn topological sort', () => {
  const base = fragment();
  const second = {
    ...base.tasks[0],
    id: 'Ingest B',
    label: 'Ingest B',
    dependsOn: ['Ingest A'],
    arguments: { inputs: ['raw/untracked/b.md'] },
    inputRefs: [{ type: 'file', ref: 'raw/untracked/b.md' }],
    idempotencyKey: 'idem-b',
  };
  const first = { ...base.tasks[0], dependsOn: ['Ingest B'] };
  const result = validateFragment(fragment({
    summary: { ...base.summary, estimatedTasks: 2 },
    tasks: [first, second],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'dependency_cycle');
});

test('planValidator rejects non concrete input refs', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    tasks: [{
      ...base.tasks[0],
      inputRefs: [{ type: 'file', ref: 'raw/untracked/*.md' }],
    }],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'non_concrete_input_ref');
});

test('planValidator rejects unavailable capabilities', () => {
  const result = validateFragment(fragment(), { registry: registry([]) });
  assert.equal(firstErrorCode(result), 'capability_unavailable');
});

test('planValidator rejects unsupported operations', () => {
  const result = validateFragment(fragment(), {
    registry: registry([provider('knowledge.update', { operations: ['export'] })]),
  });
  assert.equal(firstErrorCode(result), 'operation_unsupported');
});

test('planValidator rejects arguments that do not match provider inputSchema', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    tasks: [{
      ...base.tasks[0],
      arguments: { files: ['raw/untracked/a.md'] },
    }],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'invalid_arguments');
});

test('planValidator rejects mutating tasks without idempotency key', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    tasks: [{ ...base.tasks[0], idempotencyKey: null }],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'missing_idempotency_key');
});

test('planValidator rejects mutating tasks without locks', () => {
  const base = fragment();
  const result = validateFragment(fragment({
    tasks: [{ ...base.tasks[0], locks: [] }],
  }), { registry: registry() });
  assert.equal(firstErrorCode(result), 'missing_locks');
});

test('planValidator rejects budget violations', () => {
  const result = validateFragment(fragment(), {
    registry: registry(),
    budgets: { maxTasks: 0, maxProgressWeight: 0.5 },
  });
  assert.equal(firstErrorCode(result), 'budget_progress_weight_exceeded');
});

test('scheduler assertion rejects fragments not returned by validateFragment', () => {
  assert.throws(
    () => assertValidatedFragment(fragment()),
    (error) => error instanceof PlanValidationError && error.errors[0].code === 'fragment_not_validated',
  );
});
