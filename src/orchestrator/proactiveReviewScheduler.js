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
  staleAfterDays: 180,
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

const EVIDENCE_CHARS = 600;

// The detector's exact facts, named for the agent. A fingerprint alone makes it
// re-read the whole wiki to rediscover what the deterministic scan already
// established — and a vanished page is an ABSENCE, which cannot be rediscovered
// by reading. Bounded: the objective is a briefing, not a dump.
function evidenceDetail(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  const items = Array.isArray(evidence.items) ? evidence.items : [];
  const listed = evidence.kind === 'conflict'
    ? items.slice(0, 5).map((item) => `${item.concept}/${item.subject} (${(item.paths ?? []).join(', ')})`)
    : items.slice(0, 5).map((item) => `${item.kind}: ${item.path}`);
  const more = items.length > 5 ? '; …' : '';
  if (evidence.kind === 'conflict') {
    return `${items.length} homonym leaf group(s): ${listed.join('; ')}${more}`;
  }
  if (evidence.kind === 'stale') {
    const counts = evidence.counts ?? {};
    const parts = [
      counts.aged ? `${counts.aged} aged source(s)` : null,
      counts.vanishedArchive ? `${counts.vanishedArchive} vanished archive(s)` : null,
      counts.vanishedPage ? `${counts.vanishedPage} vanished page(s)` : null,
    ].filter(Boolean).join(', ');
    return `${parts}${listed.length ? ` — ${listed.join('; ')}` : ''}${more}`;
  }
  return '';
}

/**
 * The objective a proactive review runs under. Routing is EXPLICIT (a
 * `capabilityPlan` naming `agent.review`), so the evidence below may name any
 * path without risking the alias resolver — the reviewer is told WHAT the scan
 * found, not a fingerprint to re-derive it from.
 */
export function buildProactiveReviewObjective({ trigger, sourceVersion, evidence = null } = {}) {
  const version = sourceVersion ? ` (source ${sourceVersion})` : '';
  const fact = String(trigger ?? 'a knowledge change');
  const detail = evidenceDetail(evidence).slice(0, EVIDENCE_CHARS);
  return [
    `audit the workspace: ${fact}${version} just landed.`,
    detail ? `The deterministic scan already found: ${detail}.` : '',
    'Read the wiki and describe the gaps — no changes, no worktree.',
  ].filter(Boolean).join(' ');
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
    // How old a source's last ingest must be before `knowledge.stale` fires.
    staleAfterDays: positive(value.staleAfterDays, PROACTIVE_DEFAULTS.staleAfterDays),
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

export function createProactiveReviewScheduler({ now = () => Date.now(), db = null, pendingReviews = null } = {}) {
  // Durable spend and dedup belong beside the runtime queue, in its SQLite DB.
  // Slots are reconciled with the persisted control queue before each decision.
  db?.exec('CREATE TABLE IF NOT EXISTS proactive_review_state (workspace TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  const save = db?.prepare('INSERT INTO proactive_review_state (workspace, payload) VALUES (?, ?) ON CONFLICT(workspace) DO UPDATE SET payload = excluded.payload');
  const state = new Map((db?.prepare('SELECT workspace, payload FROM proactive_review_state').all() ?? []).map((row) => {
    const entry = JSON.parse(row.payload);
    return [row.workspace, { ...entry, seen: new Set(entry.seen), inFlight: 0, inFlightTrigger: null }];
  }));
  function persist(workspace, entry) {
    save?.run(String(workspace ?? ''), JSON.stringify({ ...entry, seen: [...entry.seen] }));
  }

  function decide({ workspace, trigger, sourceVersion = null, config = null } = {}) {
    const cfg = normalizeProactiveConfig(config);
    const skip = (reason) => ({ action: 'skip', reason, config: cfg });
    if (!cfg.enabled) return skip('disabled');
    if (!cfg.triggers.includes(String(trigger ?? ''))) return skip('trigger_disabled');
    if (pendingReviews) {
      for (const item of state.values()) { item.inFlight = 0; item.inFlightTrigger = null; }
      for (const review of pendingReviews()) {
        const pending = workspaceState(state, review.workspace);
        pending.inFlight += 1;
        pending.inFlightTrigger = review.trigger;
      }
    }
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
    // Each workspace can tighten its own limit, but cannot exceed the global
    // default by opening another workspace.
    const globalInFlight = [...state.values()].reduce((sum, item) => sum + item.inFlight, 0);
    if (globalInFlight >= PROACTIVE_DEFAULTS.concurrency) return skip('concurrency');

    if (sourceVersion != null) entry.seen.add(String(sourceVersion));
    entry.lastFiredAt = at;
    entry.dayCount += 1;
    entry.inFlight += 1;
    // What is holding the slot, so a later skip can SAY another review took
    // precedence instead of a bare "concurrency".
    entry.inFlightTrigger = String(trigger ?? '');
    persist(workspace, entry);
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
    persist(workspace, entry);
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
