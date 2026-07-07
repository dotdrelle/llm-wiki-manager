import { validateContract } from '../contracts/schemas.js';

const SUPPORTED_CONTRACT_VERSIONS = new Set(['1']);
const MUTATING_OPERATIONS = new Set([
  'copy',
  'ingest',
  'ingest_plan',
  'ingest_apply',
  'build',
  'export',
  'polish',
  'pipeline',
  'publish',
  'update',
  'delete',
  'write',
]);

const VALIDATED_FRAGMENT = Symbol('validatedTaskGraphFragment');

export class PlanValidationError extends Error {
  constructor(errors) {
    super(`Plan validation failed: ${errors.map((error) => error.code).join(', ')}`);
    this.name = 'PlanValidationError';
    this.errors = errors;
  }
}

export function validateFragment(fragment, { registry, run = {}, budgets = {} } = {}) {
  const normalizedFragment = normalizeFragment(fragment);
  const controls = [
    () => validateShape(normalizedFragment),
    () => validateContractVersion(normalizedFragment),
    () => validateAgentScope(normalizedFragment, run),
    () => validateSummary(normalizedFragment),
    () => validateTaskIds(normalizedFragment),
    () => validateGroups(normalizedFragment),
    () => validateDependencyReferences(normalizedFragment),
    () => validateDependencyAcyclic(normalizedFragment),
    () => validateConcreteInputRefs(normalizedFragment),
    () => validateCapabilities(normalizedFragment, registry),
    () => validateIdempotency(normalizedFragment, registry),
    () => validateLocks(normalizedFragment, registry),
    () => validateBudgets(normalizedFragment, budgets),
  ];

  for (const control of controls) {
    const error = control();
    if (error) return { ok: false, errors: [error], normalizedFragment: null };
  }

  markValidated(normalizedFragment);
  return { ok: true, errors: [], normalizedFragment };
}

export function assertValidatedFragment(fragment) {
  if (!isValidatedFragment(fragment)) {
    throw new PlanValidationError([issue('fragment_not_validated', 'TaskGraphFragment must pass validateFragment before scheduler entry.')]);
  }
  return fragment;
}

export function isValidatedFragment(fragment) {
  return Boolean(fragment?.[VALIDATED_FRAGMENT]);
}

function normalizeFragment(fragment) {
  const item = cloneJson(fragment) ?? {};
  const tasks = Array.isArray(item.tasks) ? item.tasks.map(normalizeTask) : [];
  const groups = Array.isArray(item.groups) ? item.groups.map(normalizeGroup) : [];
  const idMap = new Map();

  for (const task of tasks) {
    const original = String(task.id ?? '');
    const slug = slugify(original);
    task.id = slug;
    if (original) idMap.set(original, slug);
  }
  for (const group of groups) {
    const original = String(group.id ?? '');
    const slug = slugify(original);
    group.id = slug;
    if (original) idMap.set(original, slug);
  }
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.map((dep) => idMap.get(String(dep)) ?? slugify(dep));
    if (task.groupId != null) task.groupId = idMap.get(String(task.groupId)) ?? slugify(task.groupId);
    if (task.dependsOnGroup != null) task.dependsOnGroup = idMap.get(String(task.dependsOnGroup)) ?? slugify(task.dependsOnGroup);
  }

  const summary = item.summary && typeof item.summary === 'object' && !Array.isArray(item.summary)
    ? { ...item.summary }
    : {};

  return {
    ...item,
    contractVersion: String(item.contractVersion ?? '1'),
    agentInstanceId: String(item.agentInstanceId ?? ''),
    capability: String(item.capability ?? ''),
    summary: {
      label: String(summary.label ?? item.capability ?? 'Task graph fragment'),
      initialSynthesis: Array.isArray(summary.initialSynthesis) ? summary.initialSynthesis.map(String) : [],
      estimatedTasks: Number.isInteger(summary.estimatedTasks) && summary.estimatedTasks >= 0 ? summary.estimatedTasks : tasks.length,
    },
    groups,
    tasks,
    expectedOutputs: normalizeRefs(item.expectedOutputs),
  };
}

function normalizeGroup(raw) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const group = {
    ...item,
    id: String(item.id ?? ''),
    label: String(item.label ?? item.id ?? 'Task group'),
  };
  const recommendedConcurrency = normalizePositiveInteger(item.recommendedConcurrency);
  const progressWeight = normalizeNonNegativeNumber(item.progressWeight);
  if (recommendedConcurrency != null) group.recommendedConcurrency = recommendedConcurrency;
  else delete group.recommendedConcurrency;
  if (progressWeight != null) group.progressWeight = progressWeight;
  else delete group.progressWeight;
  return group;
}

function normalizeTask(raw) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const task = {
    ...item,
    id: String(item.id ?? ''),
    label: String(item.label ?? item.id ?? 'Task'),
    requiredCapability: String(item.requiredCapability ?? ''),
    operation: String(item.operation ?? ''),
    arguments: item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? { ...item.arguments } : {},
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
    parallelizable: item.parallelizable === true,
    inputRefs: normalizeRefs(item.inputRefs),
    expectedOutputRefs: normalizeRefs(item.expectedOutputRefs),
    locks: Array.isArray(item.locks) ? item.locks.map(String).filter(Boolean) : [],
    requiresApproval: item.requiresApproval === true,
    idempotencyKey: item.idempotencyKey == null ? null : String(item.idempotencyKey),
    progressWeight: normalizeNonNegativeNumber(item.progressWeight) ?? 1,
  };
  const optionalInteger = normalizePositiveInteger(item.recommendedConcurrency);
  const priority = normalizeFiniteNumber(item.priority);
  if (item.groupId != null) task.groupId = String(item.groupId);
  else delete task.groupId;
  if (item.dependsOnGroup != null) task.dependsOnGroup = String(item.dependsOnGroup);
  else delete task.dependsOnGroup;
  if (item.barrier === true) task.barrier = true;
  else delete task.barrier;
  if (optionalInteger != null) task.recommendedConcurrency = optionalInteger;
  else delete task.recommendedConcurrency;
  if (item.approvalClass != null) task.approvalClass = String(item.approvalClass);
  else delete task.approvalClass;
  if (item.approvalSummary != null) task.approvalSummary = String(item.approvalSummary);
  else delete task.approvalSummary;
  if (priority != null) task.priority = priority;
  else delete task.priority;
  if (item.retryPolicy != null) task.retryPolicy = normalizeRetryPolicy(item.retryPolicy);
  else delete task.retryPolicy;
  return task;
}

function validateShape(fragment) {
  const result = validateContract('taskGraphFragment', fragment);
  return result.ok ? null : issue('invalid_contract_shape', 'TaskGraphFragment does not match the contract schema.', { errors: result.errors });
}

function validateContractVersion(fragment) {
  return SUPPORTED_CONTRACT_VERSIONS.has(fragment.contractVersion)
    ? null
    : issue('unsupported_contract_version', `Unsupported TaskGraphFragment contractVersion: ${fragment.contractVersion}`);
}

function validateAgentScope(fragment, run) {
  const expected = run?.agentInstanceId ?? run?.plannerAgentInstanceId ?? null;
  if (!expected || fragment.agentInstanceId === String(expected)) return null;
  return issue('agent_instance_mismatch', 'Fragment agentInstanceId does not match the run planner agent.', {
    expected: String(expected),
    actual: fragment.agentInstanceId,
  });
}

function validateSummary(fragment) {
  return fragment.summary.estimatedTasks === fragment.tasks.length
    ? null
    : issue('estimated_tasks_mismatch', 'summary.estimatedTasks must match tasks.length.', {
      estimatedTasks: fragment.summary.estimatedTasks,
      actualTasks: fragment.tasks.length,
    });
}

function validateTaskIds(fragment) {
  const seen = new Set();
  for (const task of fragment.tasks) {
    if (!task.id) return issue('empty_task_id', 'Task id is empty after normalization.');
    if (seen.has(task.id)) return issue('duplicate_task_id', `Duplicate task id after normalization: ${task.id}`, { taskId: task.id });
    seen.add(task.id);
  }
  return null;
}

function validateGroups(fragment) {
  const groupIds = new Set();
  for (const group of fragment.groups) {
    if (!group.id) return issue('empty_group_id', 'Task group id is empty after normalization.');
    if (groupIds.has(group.id)) return issue('duplicate_group_id', `Duplicate group id after normalization: ${group.id}`, { groupId: group.id });
    groupIds.add(group.id);
  }
  for (const task of fragment.tasks) {
    if (task.groupId && !groupIds.has(task.groupId)) {
      return issue('unknown_group_id', `Task references unknown groupId: ${task.groupId}`, { taskId: task.id, groupId: task.groupId });
    }
    if (task.dependsOnGroup && !groupIds.has(task.dependsOnGroup)) {
      return issue('unknown_depends_on_group', `Task references unknown dependsOnGroup: ${task.dependsOnGroup}`, {
        taskId: task.id,
        groupId: task.dependsOnGroup,
      });
    }
  }
  return null;
}

function validateDependencyReferences(fragment) {
  const taskIds = new Set(fragment.tasks.map((task) => task.id));
  for (const task of fragment.tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) return issue('self_dependency', `Task depends on itself: ${task.id}`, { taskId: task.id });
      if (!taskIds.has(dep)) return issue('unknown_dependency', `Task references unknown dependency: ${dep}`, { taskId: task.id, dependencyId: dep });
    }
  }
  return null;
}

function validateDependencyAcyclic(fragment) {
  const result = topologicalSort(fragment.tasks);
  return result.cycle
    ? issue('dependency_cycle', 'Task dependency cycle detected.', { remainingTaskIds: result.remainingTaskIds })
    : null;
}

function validateConcreteInputRefs(fragment) {
  for (const task of fragment.tasks) {
    for (const ref of task.inputRefs) {
      const value = typeof ref === 'string' ? ref : ref?.ref;
      if (!value || /[*?[\]]/.test(String(value))) {
        return issue('non_concrete_input_ref', `Task inputRefs must be concrete: ${task.id}`, {
          taskId: task.id,
          ref: value ?? null,
        });
      }
    }
  }
  return null;
}

function validateCapabilities(fragment, registry) {
  if (!registry || typeof registry.providersFor !== 'function') {
    return issue('missing_capability_registry', 'Plan validation requires a capability registry.');
  }
  for (const task of fragment.tasks) {
    const providers = healthyProviders(registry.providersFor(task.requiredCapability) ?? [], registry);
    if (providers.length === 0) {
      return issue('capability_unavailable', `No healthy provider for capability: ${task.requiredCapability}`, {
        taskId: task.id,
        capability: task.requiredCapability,
      });
    }
    const operationProviders = providers.filter((provider) => supportedOperations(provider).includes(task.operation));
    if (operationProviders.length === 0) {
      return issue('operation_unsupported', `No provider supports operation ${task.operation} for capability ${task.requiredCapability}.`, {
        taskId: task.id,
        capability: task.requiredCapability,
        operation: task.operation,
      });
    }
    const argumentErrors = operationProviders
      .map((provider) => validateJsonSchema(provider.capability?.inputSchema ?? {}, task.arguments, `tasks.${task.id}.arguments`))
      .filter((errors) => errors.length === 0);
    if (argumentErrors.length === 0) {
      return issue('invalid_arguments', `Task arguments do not satisfy provider inputSchema: ${task.id}`, {
        taskId: task.id,
        capability: task.requiredCapability,
        operation: task.operation,
      });
    }
  }
  return null;
}

function validateIdempotency(fragment, registry) {
  for (const task of fragment.tasks) {
    if (isMutatingTask(task, registry) && !task.idempotencyKey) {
      return issue('missing_idempotency_key', `Mutating task requires idempotencyKey: ${task.id}`, { taskId: task.id });
    }
  }
  return null;
}

function validateLocks(fragment, registry) {
  for (const task of fragment.tasks) {
    if (isMutatingTask(task, registry) && task.locks.length === 0) {
      return issue('missing_locks', `Mutating task requires at least one lock: ${task.id}`, { taskId: task.id });
    }
  }
  return null;
}

function validateBudgets(fragment, budgets) {
  const maxTasks = normalizePositiveInteger(budgets?.maxTasks);
  if (maxTasks != null && fragment.tasks.length > maxTasks) {
    return issue('budget_max_tasks_exceeded', 'Task count exceeds budget.maxTasks.', { maxTasks, actualTasks: fragment.tasks.length });
  }
  const maxConcurrency = normalizePositiveInteger(budgets?.maxConcurrency);
  if (maxConcurrency != null) {
    const tooHigh = [
      ...fragment.groups.filter((group) => Number(group.recommendedConcurrency ?? 1) > maxConcurrency),
      ...fragment.tasks.filter((task) => Number(task.recommendedConcurrency ?? 1) > maxConcurrency),
    ][0];
    if (tooHigh) {
      return issue('budget_max_concurrency_exceeded', 'Recommended concurrency exceeds budget.maxConcurrency.', {
        maxConcurrency,
        id: tooHigh.id,
        recommendedConcurrency: tooHigh.recommendedConcurrency,
      });
    }
  }
  const maxDepth = normalizePositiveInteger(budgets?.maxDepth);
  const depth = graphDepth(fragment.tasks);
  if (maxDepth != null && depth > maxDepth) {
    return issue('budget_max_depth_exceeded', 'DAG depth exceeds budget.maxDepth.', { maxDepth, depth });
  }
  const maxProgressWeight = normalizeNonNegativeNumber(budgets?.maxProgressWeight);
  const progressWeight = fragment.tasks.reduce((sum, task) => sum + Number(task.progressWeight ?? 0), 0);
  if (maxProgressWeight != null && progressWeight > maxProgressWeight) {
    return issue('budget_progress_weight_exceeded', 'Progress weight exceeds budget.maxProgressWeight.', {
      maxProgressWeight,
      progressWeight,
    });
  }
  return null;
}

function topologicalSort(tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const outgoing = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) continue;
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      outgoing.get(dep)?.push(task.id);
    }
  }
  const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  const ordered = [];
  while (queue.length > 0) {
    const id = queue.shift();
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const count = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, count);
      if (count === 0) queue.push(next);
    }
  }
  if (ordered.length === tasks.length) return { ordered, cycle: false, remainingTaskIds: [] };
  return {
    ordered,
    cycle: true,
    remainingTaskIds: [...indegree.entries()].filter(([, count]) => count > 0).map(([id]) => id),
  };
}

function graphDepth(tasks) {
  const order = topologicalSort(tasks);
  if (order.cycle) return Infinity;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map(tasks.map((task) => [task.id, 1]));
  for (const id of order.ordered) {
    const task = byId.get(id);
    for (const dep of task?.dependsOn ?? []) {
      depth.set(id, Math.max(depth.get(id) ?? 1, (depth.get(dep) ?? 1) + 1));
    }
  }
  return Math.max(0, ...depth.values());
}

function healthyProviders(providers, registry) {
  return providers.filter((provider) => {
    const contractVersion = provider.description?.contractVersion ?? provider.contractVersion;
    const compatible = typeof registry.isCompatible === 'function'
      ? registry.isCompatible(contractVersion)
      : String(contractVersion ?? '1') === '1';
    const health = String(provider.health ?? provider.description?.health?.status ?? '');
    return compatible && ['available', 'degraded'].includes(health);
  });
}

function supportedOperations(provider) {
  return Array.isArray(provider.capability?.supportedOperations)
    ? provider.capability.supportedOperations.map(String)
    : [];
}

function isMutatingTask(task, registry) {
  if (task.requiresApproval === true || MUTATING_OPERATIONS.has(task.operation)) return true;
  const providers = registry?.providersFor?.(task.requiredCapability) ?? [];
  return providers.some((provider) => {
    const capability = provider.capability ?? {};
    return capability.defaultRequiresApproval === true || typeof capability.mutationClass === 'string';
  });
}

function validateJsonSchema(schema, value, path) {
  const errors = [];
  validateSchema(schema || {}, value, path, errors);
  return errors;
}

function validateSchema(schema, value, path, errors) {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateJsonSchema(candidate, value, path).length === 0);
    if (matches.length !== 1) errors.push(`${path} must match exactly one schema`);
    return;
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((candidate) => validateJsonSchema(candidate, value, path).length === 0);
    if (matches.length < 1) errors.push(`${path} must match at least one schema`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (schema.type && !schemaTypeMatches(schema.type, value)) errors.push(`${path} must be ${formatSchemaType(schema.type)}`);
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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
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

function schemaTypeMatches(type, value) {
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

function formatSchemaType(type) {
  return Array.isArray(type) ? type.join('|') : type;
}

function normalizeRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return { ...item };
    return String(item);
  });
}

function normalizeRetryPolicy(value) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    maxAttempts: normalizePositiveInteger(item.maxAttempts) ?? 1,
    retryableErrors: Array.isArray(item.retryableErrors) ? item.retryableErrors.map(String) : [],
    allowAgentFallback: item.allowAgentFallback === true,
  };
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

function normalizeNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function slugify(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

function markValidated(fragment) {
  Object.defineProperty(fragment, VALIDATED_FRAGMENT, {
    value: true,
    enumerable: false,
    configurable: false,
  });
}

function issue(code, message, details = {}) {
  return { code, message, details };
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
