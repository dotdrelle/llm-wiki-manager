const STATUS_VALUES = [
  'pending',
  'queued',
  'running',
  'waiting',
  'waiting_approval',
  'pending_approval',
  'done',
  'failed',
  'cancelled',
  'canceled',
  'stalled',
  'added_during_run',
  'error',
  'complete',
  'completed',
  'success',
];

const nullableString = { type: ['string', 'null'] };
const nullableObject = { type: ['object', 'null'], additionalProperties: true };
const stringArraySchema = { type: 'array', items: { type: 'string' } };
const outputReferenceSchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/output-reference/v1',
  title: 'OutputReference',
  schemaVersion: '1',
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['type', 'ref'],
      additionalProperties: true,
      properties: {
        type: { type: 'string' },
        ref: { type: 'string' },
        label: nullableString,
        workspace: nullableString,
      },
    },
  ],
};

const retryPolicySchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/retry-policy/v1',
  title: 'RetryPolicy',
  schemaVersion: '1',
  type: 'object',
  required: ['maxAttempts', 'retryableErrors', 'allowAgentFallback'],
  additionalProperties: false,
  properties: {
    maxAttempts: { type: 'integer', minimum: 1 },
    retryableErrors: stringArraySchema,
    allowAgentFallback: { type: 'boolean' },
  },
};

const jsonSchemaSchema = { type: 'object', additionalProperties: true };
const capabilityDescriptionSchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/capability-description/v1',
  title: 'CapabilityDescription',
  schemaVersion: '1',
  type: 'object',
  required: ['id', 'version', 'description', 'inputSchema', 'outputSchema', 'supportedOperations'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    inputSchema: jsonSchemaSchema,
    outputSchema: jsonSchemaSchema,
    supportedOperations: stringArraySchema,
    mutationClass: { type: 'string' },
    defaultRequiresApproval: { type: 'boolean' },
    estimatedCost: {
      type: 'object',
      additionalProperties: false,
      properties: {
        llmCalls: { type: 'number', minimum: 0 },
        tokenRange: { type: 'array', items: { type: 'number' } },
      },
    },
  },
};

const agentDescriptionSchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/agent-description/v1',
  title: 'AgentDescription',
  schemaVersion: '1',
  type: 'object',
  required: ['contractVersion', 'agentType', 'agentInstanceId', 'displayName', 'capabilities', 'orchestration', 'limits', 'health'],
  additionalProperties: true,
  properties: {
    contractVersion: { type: 'string', minLength: 1 },
    agentType: { type: 'string', minLength: 1 },
    agentInstanceId: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1 },
    capabilities: { type: 'array', items: capabilityDescriptionSchema },
    orchestration: {
      type: 'object',
      required: ['canPlan', 'canExpandPlan', 'canExecute', 'canCancel', 'canResume', 'supportsIdempotency', 'supportsParallelWorkers'],
      additionalProperties: true,
      properties: {
        canPlan: { type: 'boolean' },
        canExpandPlan: { type: 'boolean' },
        canExecute: { type: 'boolean' },
        canCancel: { type: 'boolean' },
        canResume: { type: 'boolean' },
        supportsIdempotency: { type: 'boolean' },
        supportsParallelWorkers: { type: 'boolean' },
      },
    },
    limits: {
      type: 'object',
      required: ['recommendedConcurrency', 'maxConcurrency'],
      additionalProperties: true,
      properties: {
        recommendedConcurrency: { type: 'number', minimum: 0 },
        maxConcurrency: { type: 'number', minimum: 0 },
        maxTasksPerPlan: { type: 'number', minimum: 0 },
        maxTaskDurationMs: { type: 'number', minimum: 0 },
      },
    },
    health: {
      type: 'object',
      required: ['status'],
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['available', 'degraded', 'unavailable'] },
      },
    },
  },
};

const taskGroupSchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/task-group/v1',
  title: 'TaskGroup',
  schemaVersion: '1',
  type: 'object',
  required: ['id', 'label'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    recommendedConcurrency: { type: 'integer', minimum: 1 },
    progressWeight: { type: 'number', minimum: 0 },
  },
};

const plannedTaskSchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/planned-task/v1',
  title: 'PlannedTask',
  schemaVersion: '1',
  type: 'object',
  required: [
    'id',
    'label',
    'requiredCapability',
    'operation',
    'dependsOn',
    'parallelizable',
    'inputRefs',
    'locks',
    'requiresApproval',
    'idempotencyKey',
    'progressWeight',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    requiredCapability: { type: 'string', minLength: 1 },
    operation: { type: 'string', minLength: 1 },
    arguments: { type: 'object', additionalProperties: true },
    groupId: { type: 'string' },
    dependsOn: stringArraySchema,
    dependsOnGroup: { type: 'string' },
    barrier: { type: 'boolean' },
    parallelizable: { type: 'boolean' },
    recommendedConcurrency: { type: 'integer', minimum: 1 },
    inputRefs: { type: 'array', items: outputReferenceSchema },
    expectedOutputRefs: { type: 'array', items: outputReferenceSchema },
    locks: stringArraySchema,
    requiresApproval: { type: 'boolean' },
    approvalClass: { type: 'string' },
    approvalSummary: { type: 'string' },
    idempotencyKey: { type: ['string', 'null'] },
    progressWeight: { type: 'number', minimum: 0 },
    priority: { type: 'number' },
    retryPolicy: retryPolicySchema,
  },
};

const taskGraphFragmentSchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/task-graph-fragment/v1',
  title: 'TaskGraphFragment',
  schemaVersion: '1',
  type: 'object',
  required: ['contractVersion', 'agentInstanceId', 'capability', 'summary', 'groups', 'tasks'],
  additionalProperties: false,
  properties: {
    contractVersion: { type: 'string', minLength: 1 },
    agentInstanceId: { type: 'string', minLength: 1 },
    capability: { type: 'string', minLength: 1 },
    summary: {
      type: 'object',
      required: ['label', 'initialSynthesis', 'estimatedTasks'],
      additionalProperties: false,
      properties: {
        label: { type: 'string', minLength: 1 },
        initialSynthesis: stringArraySchema,
        estimatedTasks: { type: 'integer', minimum: 0 },
      },
    },
    groups: { type: 'array', items: taskGroupSchema },
    tasks: { type: 'array', items: plannedTaskSchema },
    expectedOutputs: { type: 'array', items: outputReferenceSchema },
  },
};

const planExpansionRequestSchema = {
  $id: 'https://dotdrelle.dev/wiki-manager/contracts/plan-expansion-request/v1',
  title: 'PlanExpansionRequest',
  schemaVersion: '1',
  type: 'object',
  required: ['capability'],
  additionalProperties: true,
  properties: {
    capability: { type: 'string', minLength: 1 },
    operation: nullableString,
    objective: nullableString,
    reason: nullableString,
    arguments: { type: 'object', additionalProperties: true },
    workspace: { type: 'object', additionalProperties: true },
    constraints: {
      type: 'object',
      additionalProperties: true,
      properties: {
        maxTasks: { type: 'integer', minimum: 1 },
        maxConcurrency: { type: 'integer', minimum: 1 },
        maxDepth: { type: 'integer', minimum: 1 },
        requireApprovalForMutations: { type: 'boolean' },
      },
    },
    insertBeforeTasks: stringArraySchema,
    insertAfterTasks: stringArraySchema,
  },
};

// Shared by planStepSchema and patchTaskSchema, which differ only in their
// `id`/`description` requiredness — every other field is identical.
const taskFieldsSchema = {
  label: { type: 'string' },
  requiredCapability: { type: ['string', 'null'] },
  operation: { type: ['string', 'null'] },
  arguments: { type: 'object', additionalProperties: true },
  groupId: nullableString,
  status: { type: 'string' },
  dependsOn: { type: 'array', items: { type: 'string' } },
  dependsOnGroup: nullableString,
  barrier: { type: 'boolean' },
  parallelizable: { type: 'boolean' },
  recommendedConcurrency: { type: 'integer', minimum: 1 },
  executor: nullableString,
  executorQuery: nullableObject,
  inputRefs: { type: 'array', items: outputReferenceSchema },
  expectedOutputRefs: { type: 'array', items: outputReferenceSchema },
  locks: stringArraySchema,
  requiresApproval: { type: 'boolean' },
  approvalClass: nullableString,
  approvalSummary: nullableString,
  idempotencyKey: { type: ['string', 'null'] },
  progressWeight: { type: 'number', minimum: 0 },
  priority: { type: 'number' },
  retryPolicy: retryPolicySchema,
  outputRefs: { type: 'array', items: outputReferenceSchema },
};

const planStepSchema = {
  type: 'object',
  required: ['description', 'status', 'dependsOn', 'outputRefs'],
  additionalProperties: true,
  properties: {
    step: { type: 'number' },
    id: nullableString,
    description: { type: 'string' },
    ...taskFieldsSchema,
  },
};

const patchTaskSchema = {
  type: 'object',
  required: ['id', 'description'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
    ...taskFieldsSchema,
  },
};

export const contractSchemas = {
  activity: {
    $id: 'https://dotdrelle.dev/wiki-manager/contracts/activity/v1',
    title: '_activity',
    schemaVersion: '1',
    type: 'object',
    required: ['schemaVersion', 'id', 'source', 'kind', 'label', 'status', 'progress', 'poll', 'outputRefs'],
    additionalProperties: true,
    properties: {
      schemaVersion: { const: '1' },
      id: { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      label: { type: 'string' },
      status: { type: 'string' },
      progress: {
        type: 'object',
        additionalProperties: true,
        properties: {
          percent: { type: 'number', minimum: 0, maximum: 100 },
          stepId: { type: 'string' },
          parentActivityKey: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      poll: nullableObject,
      outputRefs: { type: 'array', items: outputReferenceSchema },
    },
  },
  agentRunEvent: {
    $id: 'https://dotdrelle.dev/wiki-manager/contracts/agent-run-event/v1',
    title: 'AgentRunEvent',
    schemaVersion: '1',
    type: 'object',
    required: ['id', 'ts', 'type', 'origin', 'payload'],
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      ts: { type: 'string' },
      type: { type: 'string' },
      origin: { type: 'string' },
      runId: nullableString,
      turnId: nullableString,
      taskId: nullableString,
      workspace: nullableString,
      payload: { type: 'object', additionalProperties: true },
    },
  },
  runRequest: {
    $id: 'https://dotdrelle.dev/wiki-manager/contracts/run-request/v1',
    title: 'RuntimeRunRequest',
    schemaVersion: '1',
    type: 'object',
    required: ['input'],
    additionalProperties: true,
    properties: {
      input: { type: 'string', minLength: 1 },
      prompt: { type: 'string' },
      workspace: nullableString,
      runId: nullableString,
      turnId: nullableString,
    },
  },
  controlMessage: {
    $id: 'https://dotdrelle.dev/wiki-manager/contracts/control-message/v1',
    title: 'RuntimeControlMessage',
    schemaVersion: '1',
    type: 'object',
    required: ['action'],
    additionalProperties: true,
    properties: {
      action: { type: 'string', enum: ['status', 'explain', 'message', 'enqueue', 'approve_patch', 'reject_patch'] },
      input: { type: 'string' },
      message: { type: 'string' },
      prompt: { type: 'string' },
      request: { type: 'string' },
      intent: { type: 'string', enum: ['observe', 'converse', 'mutate', 'enqueue', 'approve', 'modify_run', 'enqueue_run', 'cancel', 'ambiguous'] },
      workspace: nullableString,
      patchId: { type: 'string' },
      id: { type: 'string' },
      reason: { type: 'string' },
    },
  },
  plan: {
    $id: 'https://dotdrelle.dev/wiki-manager/contracts/plan/v1',
    title: 'StructuredPlan',
    schemaVersion: '1',
    type: 'array',
    items: { anyOf: [planStepSchema, plannedTaskSchema] },
  },
  planPatch: {
    $id: 'https://dotdrelle.dev/wiki-manager/contracts/plan-patch/v1',
    title: 'PlanPatch',
    schemaVersion: '1',
    type: 'object',
    required: ['basePlanRevision', 'operations'],
    additionalProperties: true,
    properties: {
      id: nullableString,
      targetRunId: nullableString,
      basePlanRevision: { type: 'number', minimum: 0 },
      reason: nullableString,
      operations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op'],
          additionalProperties: true,
          properties: {
            op: { type: 'string', enum: ['add_task', 'add_dependency', 'remove_dependency', 'cancel_task', 'replace_executor', 'request_approval'] },
            task: { anyOf: [patchTaskSchema, plannedTaskSchema] },
            taskId: { type: 'string' },
            targetTaskId: { type: 'string' },
            dependencyId: { type: 'string' },
            dependsOn: { type: 'string' },
            executor: nullableString,
            executorQuery: nullableObject,
            reason: { type: 'string' },
          },
        },
      },
    },
  },
  outputReference: outputReferenceSchema,
  capabilityDescription: capabilityDescriptionSchema,
  agentDescription: agentDescriptionSchema,
  retryPolicy: retryPolicySchema,
  taskGroup: taskGroupSchema,
  plannedTask: plannedTaskSchema,
  taskGraphFragment: taskGraphFragmentSchema,
  planExpansionRequest: planExpansionRequestSchema,
};

export function validateContract(name, value) {
  const schema = contractSchemas[name];
  if (!schema) {
    throw new Error(`Unknown contract schema: ${name}`);
  }
  const errors = [];
  validateSchema(schema, value, name, errors);
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function assertContract(name, value) {
  const result = validateContract(name, value);
  if (!result.ok) {
    throw new Error(`Contract ${name} invalid: ${result.errors.join('; ')}`);
  }
  return value;
}

export function validateContractInDev(name, value) {
  if (!contractValidationEnabled()) return value;
  return assertContract(name, value);
}

export function contractValidationEnabled() {
  return process.env.WIKI_MANAGER_VALIDATE_CONTRACTS === '1'
    || process.env.CI === 'true'
    || (process.env.NODE_ENV && process.env.NODE_ENV !== 'production');
}

function validateSchema(schema, value, path, errors) {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateCandidate(candidate, value, path));
    if (matches.length !== 1) errors.push(`${path} must match exactly one schema`);
    return;
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((candidate) => validateCandidate(candidate, value, path));
    if (matches.length < 1) errors.push(`${path} must match at least one schema`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return;
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path} must be ${formatType(schema.type)}`);
    return;
  }
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${path} must have length >= ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSchema(schema.items ?? {}, item, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateSchema(childSchema, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
}

function validateCandidate(schema, value, path) {
  const errors = [];
  validateSchema(schema, value, path, errors);
  return errors.length === 0;
}

function typeMatches(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === 'array') return Array.isArray(value);
    if (candidate === 'null') return value === null;
    if (candidate === 'integer') return Number.isInteger(value);
    if (candidate === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (candidate === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return typeof value === candidate;
  });
}

function formatType(type) {
  return Array.isArray(type) ? type.join('|') : type;
}

export { STATUS_VALUES };
