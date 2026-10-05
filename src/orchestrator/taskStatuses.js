/**
 * Single vocabulary for task statuses.
 *
 * Fourteen modules each carried their own list: `['done', 'failed',
 * 'cancelled']` here, a `Set` with `success` and `succeeded` there, a third
 * that added `error` but forgot `canceled`. None was wrong in isolation;
 * together they did not describe the same world. A `skipped` status
 * introduced in the scheduler was terminal for it, unknown to the projection
 * — which read it as a success — and non-terminal for the panels, where the
 * task spun indefinitely.
 *
 * This module is therefore the only definition. Aliases exist because
 * external agents produce them: `error` for `failed`, `succeeded` for `done`,
 * `canceled` for `cancelled`. Normalising them at the input avoids having to
 * recognise them at every comparison.
 */

/** Success: the task produced what was expected of it. */
export const SUCCESS_STATUSES = Object.freeze(['done', 'complete', 'completed', 'success', 'succeeded']);
/** Failure: the task was attempted and did not succeed. */
export const FAILURE_STATUSES = Object.freeze(['failed', 'error', 'stalled']);
/** Cancellation: stopped by a decision, not by a defect. */
export const CANCELLED_STATUSES = Object.freeze(['cancelled', 'canceled']);
/** Abandonment: never attempted, because it could no longer be. */
export const SKIPPED_STATUSES = Object.freeze(['skipped']);
/** Pending: not yet executable, but able to become so. */
export const PENDING_STATUSES_LIST = Object.freeze(['pending', 'pending_approval', 'waiting_approval']);
/** En cours : un agent y travaille en ce moment. */
export const ACTIVE_STATUSES = Object.freeze(['running', 'in_progress', 'started', 'starting']);

/**
 * Terminal, reduced to its four canonical forms (aliases are normalised
 * before comparison). Modules that copied `['done','failed',
 * 'cancelled','skipped']` into a `Set` import this one instead.
 */
export const TERMINAL_STATUSES = Object.freeze(['done', 'failed', 'cancelled', 'skipped']);
export const TERMINAL_STATUS_SET = new Set(TERMINAL_STATUSES);

const ALIASES = new Map([
  ...SUCCESS_STATUSES.map((status) => [status, 'done']),
  ...FAILURE_STATUSES.map((status) => [status, 'failed']),
  ...CANCELLED_STATUSES.map((status) => [status, 'cancelled']),
  ...SKIPPED_STATUSES.map((status) => [status, 'skipped']),
  ...ACTIVE_STATUSES.map((status) => [status, 'running']),
  // The waiting statuses stay distinct: `pending_approval` and
  // `waiting_approval` do not ask for the same thing as `pending`, and
  // confusing them would make approval requests disappear.
  ...PENDING_STATUSES_LIST.map((status) => [status, status]),
]);

/**
 * Canonical status, or `null` when the vocabulary does not know it.
 *
 * The `null` is a result, not an accident: it is what lets callers treat the
 * unknown as unknown rather than silently filing it on the side that suits
 * them.
 */
export function normalizeTaskStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (!value) return null;
  return ALIASES.get(value) ?? null;
}

export function isSuccessful(status) {
  return normalizeTaskStatus(status) === 'done';
}

export function isFailed(status) {
  return normalizeTaskStatus(status) === 'failed';
}

export function isCancelled(status) {
  return normalizeTaskStatus(status) === 'cancelled';
}

export function isSkipped(status) {
  return normalizeTaskStatus(status) === 'skipped';
}

export function isPending(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized != null && PENDING_STATUSES_LIST.includes(normalized);
}

export function isActive(status) {
  return normalizeTaskStatus(status) === 'running';
}

/** Terminal: nothing more will happen to this task in this run. */
export function isTerminal(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized === 'done' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'skipped';
}

/**
 * Terminal without having succeeded. Groups failure, cancellation and
 * abandonment — the distinction matters for the user report, not for deciding
 * whether the rest of the plan can rely on it.
 */
export function isUnsuccessfulTerminal(status) {
  return isTerminal(status) && !isSuccessful(status);
}

/** True for a status no set recognises. */
export function isUnknownStatus(status) {
  return String(status ?? '').trim() !== '' && normalizeTaskStatus(status) == null;
}
