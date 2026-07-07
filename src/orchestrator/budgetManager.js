export class BudgetExceededError extends Error {
  constructor(reason, details = {}) {
    super(`Run budget exceeded: ${reason}`);
    this.name = 'BudgetExceededError';
    this.reason = reason;
    this.details = details;
  }
}

export function createBudgetManager({ budgets = {}, runId = null } = {}) {
  const limits = normalizeBudgets(budgets);
  const counters = {
    runId,
    tasksStarted: 0,
    tasksCompleted: 0,
    attempts: 0,
    durationMs: 0,
    tokens: 0,
    maxDepthSeen: 0,
  };
  let exceeded = null;

  return {
    canStartTask(task) {
      const check = checkStartBudget(task, counters, limits);
      if (!check.ok) exceeded = check;
      return check.ok;
    },
    assertCanStartTask(task) {
      const check = checkStartBudget(task, counters, limits);
      if (!check.ok) {
        exceeded = check;
        throw new BudgetExceededError(check.reason, check.details);
      }
      return true;
    },
    recordTaskStart(task) {
      this.assertCanStartTask(task);
      counters.tasksStarted += 1;
      counters.attempts += 1;
      counters.maxDepthSeen = Math.max(counters.maxDepthSeen, taskDepth(task));
      return this.snapshot();
    },
    recordTaskResult(result = {}) {
      counters.tasksCompleted += 1;
      const metrics = result.metrics && typeof result.metrics === 'object' ? result.metrics : {};
      counters.durationMs += nonNegativeNumber(metrics.durationMs);
      counters.tokens += tokenCount(metrics);
      const check = checkConsumedBudget(counters, limits);
      if (!check.ok) {
        exceeded = check;
        throw new BudgetExceededError(check.reason, check.details);
      }
      return this.snapshot();
    },
    markExceeded(reason, details = {}) {
      exceeded = { ok: false, reason, details };
      return exceeded;
    },
    exceeded() {
      return exceeded;
    },
    snapshot() {
      return { ...counters, exceeded };
    },
  };
}

function checkStartBudget(task, counters, limits) {
  if (limits.maxTasks != null && counters.tasksStarted + 1 > limits.maxTasks) {
    return exceeded('max_tasks_exceeded', { maxTasks: limits.maxTasks, nextTasksStarted: counters.tasksStarted + 1 });
  }
  if (limits.maxAttempts != null && counters.attempts + 1 > limits.maxAttempts) {
    return exceeded('max_attempts_exceeded', { maxAttempts: limits.maxAttempts, nextAttempts: counters.attempts + 1 });
  }
  const depth = taskDepth(task);
  if (limits.maxDepth != null && depth > limits.maxDepth) {
    return exceeded('max_depth_exceeded', { maxDepth: limits.maxDepth, taskDepth: depth, taskId: task?.id ?? task?.step ?? null });
  }
  return { ok: true };
}

function checkConsumedBudget(counters, limits) {
  if (limits.maxDurationMs != null && counters.durationMs > limits.maxDurationMs) {
    return exceeded('max_duration_exceeded', { maxDurationMs: limits.maxDurationMs, durationMs: counters.durationMs });
  }
  if (limits.maxTokens != null && counters.tokens > limits.maxTokens) {
    return exceeded('max_tokens_exceeded', { maxTokens: limits.maxTokens, tokens: counters.tokens });
  }
  return { ok: true };
}

function normalizeBudgets(budgets) {
  return {
    maxTasks: positiveInteger(budgets.maxTasks),
    maxAttempts: positiveInteger(budgets.maxAttempts ?? budgets.maxTaskAttempts),
    maxDepth: positiveInteger(budgets.maxDepth),
    maxDurationMs: positiveInteger(budgets.maxDurationMs ?? budgets.maxRunDurationMs),
    maxTokens: positiveInteger(budgets.maxTokens),
  };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tokenCount(metrics) {
  if (metrics.totalTokens != null) return nonNegativeNumber(metrics.totalTokens);
  if (metrics.tokens != null) return nonNegativeNumber(metrics.tokens);
  return nonNegativeNumber(metrics.inputTokens) + nonNegativeNumber(metrics.outputTokens);
}

function taskDepth(task) {
  const value = task?.depth ?? task?.dagDepth ?? task?.level ?? 1;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 1;
}

function exceeded(reason, details) {
  return { ok: false, reason, details };
}
