const STATUS_VALUES = [
  'pending',
  'queued',
  'running',
  'waiting',
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

const planStepSchema = {
  type: 'object',
  required: ['description', 'status', 'dependsOn', 'outputRefs'],
  additionalProperties: true,
  properties: {
    step: { type: 'number' },
    id: nullableString,
    description: { type: 'string' },
    status: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'string' } },
    executor: nullableString,
    executorQuery: nullableObject,
    outputRefs: { type: 'array', items: outputReferenceSchema },
  },
};

const patchTaskSchema = {
  type: 'object',
  required: ['id', 'description'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
    status: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'string' } },
    executor: nullableString,
    executorQuery: nullableObject,
    outputRefs: { type: 'array', items: outputReferenceSchema },
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
      intent: { type: 'string', enum: ['observe', 'converse', 'mutate', 'enqueue'] },
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
    items: planStepSchema,
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
            task: patchTaskSchema,
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
