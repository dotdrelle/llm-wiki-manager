/*
 Proactive reviews: the manager noticing, from a fact it already computed, that
 a workspace is worth auditing — and PROPOSING one, never mutating anything.

 This module is the deterministic decision only: which task completion is a
 trigger, whether the workspace's opt-in config allows one, and the dedup /
 cooldown / budget arithmetic. Enqueueing the run and persisting the resulting
 note belong to the runtime; keeping the decision pure is what makes it
 testable without a session, a queue or a model.
*/

// Read-only, no worktree: the review capability the gateway already declares.
export const PROACTIVE_REVIEW_CAPABILITY = 'agent.review';

export const PROACTIVE_DEFAULTS = {
  enabled: false,
  triggers: [
    'knowledge.ingested',
    'knowledge.rebuilt',
    'knowledge.stale',
    'knowledge.conflict_detected',
  ],
  cooldownMs: 6 * 60 * 60 * 1000,
  runsPerDay: 4,
  concurrency: 1,
};

/**
 * Which task completion is a trigger. Derived from the capability/operation
 * the production agent actually exposes — never a registered list an agent
 * could silently stop matching.
 */
export function triggerForTask({ capability, operation } = {}) {
  const cap = String(capability ?? '').trim();
  const op = String(operation ?? '').trim();
  // `ingest_plan` is a dry-run under `knowledge.update` (read lock, writes only
  // `.wiki/ingest-plans/`): the corpus has not moved, so it must be excluded
  // BEFORE the capability check that would otherwise accept it.
  if (op === 'ingest_plan') return null;
  if (cap === 'knowledge.rebuild' || op === 'ingest_rebuild') return 'knowledge.rebuilt';
  if (
    cap === 'knowledge.update'
    || cap === 'knowledge.pipeline' // the default one-shot path: it ingests too
    || op === 'ingest'
    || op === 'ingest_apply'
    || op === 'pipeline'
  ) {
    return 'knowledge.ingested';
  }
  return null;
}

/**
 * The objective a proactive review runs under. It carries the `audit` alias so
 * the deterministic resolver lands on `agent.review` — read-only, no worktree,
 * no mutation — and says why it was triggered, so the run's own output explains
 * itself.
 *
 * Every other capability alias must be ABSENT: the resolver returns null when
 * two aliases match, and `agent.notify` owns `report`, `agent.curate` owns
 * `clean`/`fix`, etc. This sentence is deliberately restricted to `audit`.
 */
export function buildProactiveReviewObjective({ trigger, sourceVersion } = {}) {
  const version = sourceVersion ? ` (source ${sourceVersion})` : '';
  const fact = String(trigger ?? 'a knowledge change');
  return `audit the workspace: ${fact}${version} just landed. Read the wiki and describe the gaps — no changes, no worktree.`;
}

/**
 * The workspace's opt-in block (`proactiveReviews` in `.wikirc.yaml`). Missing
 * or malformed means DISABLED: a typo must never turn on spend the operator
 * did not ask for.
 */
export function normalizeProactiveConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...PROACTIVE_DEFAULTS, triggers: [...PROACTIVE_DEFAULTS.triggers] };
  }
  const positive = (raw, fallback) => {
    const number = Number(raw);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };
  const triggers = Array.isArray(value.triggers)
    ? value.triggers.map((trigger) => String(trigger).trim()).filter(Boolean)
    : [...PROACTIVE_DEFAULTS.triggers];
  return {
    enabled: value.enabled === true,
    triggers,
    cooldownMs: positive(value.cooldownMs, PROACTIVE_DEFAULTS.cooldownMs),
    runsPerDay: positive(value?.budget?.runsPerDay, PROACTIVE_DEFAULTS.runsPerDay),
    concurrency: Math.max(1, positive(value.concurrency, PROACTIVE_DEFAULTS.concurrency)),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function workspaceState(state, workspace) {
  const key = String(workspace ?? '');
  let entry = state.get(key);
  if (!entry) {
    entry = { lastFiredAt: null, seen: new Set(), dayStartedAt: null, dayCount: 0, inFlight: 0 };
    state.set(key, entry);
  }
  return entry;
}

export function createProactiveReviewScheduler({ now = () => Date.now() } = {}) {
  const state = new Map();

  function decide({ workspace, trigger, sourceVersion = null, config = null } = {}) {
    const cfg = normalizeProactiveConfig(config);
    const skip = (reason) => ({ action: 'skip', reason, config: cfg });
    if (!cfg.enabled) return skip('disabled');
    if (!cfg.triggers.includes(String(trigger ?? ''))) return skip('trigger_disabled');
    const entry = workspaceState(state, workspace);
    const at = now();
    // The daily window is what bounds `seen`: pruning it at rollover keeps
    // dedup per-day without an ever-growing Set in a long-lived process (the
    // same family as MAX_SESSION_EVENTS and run.events).
    if (entry.dayStartedAt == null || at - entry.dayStartedAt >= DAY_MS) {
      entry.dayStartedAt = at;
      entry.dayCount = 0;
      entry.seen.clear();
    }
    // The same source version is the same review: a second task of one ingest
    // run must not queue a second audit.
    if (sourceVersion != null && entry.seen.has(String(sourceVersion))) return skip('duplicate');
    if (entry.inFlight >= cfg.concurrency) return skip('concurrency');
    if (entry.lastFiredAt != null && at - entry.lastFiredAt < cfg.cooldownMs) return skip('cooldown');
    if (entry.dayCount >= cfg.runsPerDay) return skip('budget');

    if (sourceVersion != null) entry.seen.add(String(sourceVersion));
    entry.lastFiredAt = at;
    entry.dayCount += 1;
    entry.inFlight += 1;
    // What is holding the slot, so a later skip can SAY another review took
    // precedence instead of a bare "concurrency".
    entry.inFlightTrigger = String(trigger ?? '');
    return {
      action: 'review',
      config: cfg,
      capability: PROACTIVE_REVIEW_CAPABILITY,
      workspace: String(workspace ?? ''),
      trigger: String(trigger ?? ''),
      sourceVersion: sourceVersion == null ? null : String(sourceVersion),
    };
  }

  // Called when the review run reaches a terminal state (success, failure or
  // cancellation), so the concurrency slot is never leaked. `undo` is for the
  // failure path where the review was never actually queued: it returns the
  // budget unit and releases the version, instead of burning an audit that
  // will never happen. Never allocates state for an unknown workspace.
  function release(workspace, { undo = false, sourceVersion = null } = {}) {
    const entry = state.get(String(workspace ?? ''));
    if (!entry) return;
    if (entry.inFlight > 0) entry.inFlight -= 1;
    if (entry.inFlight <= 0) entry.inFlightTrigger = null;
    if (undo) {
      if (entry.dayCount > 0) entry.dayCount -= 1;
      if (sourceVersion != null) entry.seen.delete(String(sourceVersion));
    }
  }

  // Display-only: what the budget panel reads. A read must not allocate.
  function snapshot(workspace) {
    const entry = state.get(String(workspace ?? ''));
    if (!entry) return { lastFiredAt: null, runsToday: 0, inFlight: 0, inFlightTrigger: null, seenVersions: 0 };
    return {
      lastFiredAt: entry.lastFiredAt,
      runsToday: entry.dayCount,
      inFlight: entry.inFlight,
      inFlightTrigger: entry.inFlightTrigger ?? null,
      seenVersions: entry.seen.size,
    };
  }

  // How many workspaces carry scheduler state — a cheap diagnostic, and the
  // proof that a display read never allocates.
  function workspaceCount() {
    return state.size;
  }

  return { decide, release, snapshot, workspaceCount };
}
