import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROACTIVE_DEFAULTS,
  buildProactiveReviewObjective,
  createProactiveReviewScheduler,
  normalizeProactiveConfig,
  triggerForTask,
} from './proactiveReviewScheduler.js';

test('triggerForTask derives the two knowledge facts from the real capabilities', () => {
  assert.equal(triggerForTask({ capability: 'knowledge.update', operation: 'ingest_apply' }), 'knowledge.ingested');
  assert.equal(triggerForTask({ operation: 'ingest' }), 'knowledge.ingested');
  assert.equal(triggerForTask({ capability: 'knowledge.rebuild', operation: 'run' }), 'knowledge.rebuilt');
  assert.equal(triggerForTask({ operation: 'ingest_rebuild' }), 'knowledge.rebuilt');
  assert.equal(triggerForTask({ capability: 'knowledge.pipeline', operation: 'pipeline' }), 'knowledge.ingested');
  // A dry-run takes a read lock and writes only .wiki/ingest-plans/: the corpus
  // has not moved, so there is nothing new to audit.
  assert.equal(triggerForTask({ capability: 'knowledge.update', operation: 'ingest_plan' }), null);
  assert.equal(triggerForTask({ operation: 'ingest_plan' }), null);
  assert.equal(triggerForTask({ capability: 'document.build', operation: 'build' }), null);
  assert.equal(triggerForTask({ capability: 'knowledge.check', operation: 'lint' }), null);
  assert.equal(triggerForTask({}), null);
});

test('normalizeProactiveConfig stays disabled on anything malformed', () => {
  assert.equal(normalizeProactiveConfig(undefined).enabled, false);
  assert.equal(normalizeProactiveConfig('yes').enabled, false);
  assert.equal(normalizeProactiveConfig({ enabled: 'true' }).enabled, false, 'only a real boolean opts in');
  const config = normalizeProactiveConfig({ enabled: true, cooldownMs: -5, budget: { runsPerDay: 2 } });
  assert.equal(config.enabled, true);
  assert.equal(config.cooldownMs, PROACTIVE_DEFAULTS.cooldownMs, 'a negative cooldown falls back');
  assert.equal(config.runsPerDay, 2);
  assert.equal(config.staleAfterDays, PROACTIVE_DEFAULTS.staleAfterDays);
  assert.equal(normalizeProactiveConfig({ enabled: true, staleAfterDays: 30 }).staleAfterDays, 30);
});

test('the same source version never queues a second audit', () => {
  const scheduler = createProactiveReviewScheduler();
  // concurrency 2 so the second decision reaches the cooldown, not the slot.
  const config = { enabled: true, concurrency: 2 };
  assert.equal(
    scheduler.decide({ workspace: 'docs', trigger: 'knowledge.ingested', sourceVersion: 'v1', config }).action,
    'review',
  );
  const again = scheduler.decide({ workspace: 'docs', trigger: 'knowledge.ingested', sourceVersion: 'v1', config });
  assert.equal(again.action, 'skip');
  assert.equal(again.reason, 'duplicate');
  const other = scheduler.decide({ workspace: 'docs', trigger: 'knowledge.ingested', sourceVersion: 'v2', config });
  assert.equal(other.reason, 'cooldown', 'a different version still waits for the cooldown');
});

test('cooldown and budget bound the spend per workspace', () => {
  let clock = 1_000_000;
  const scheduler = createProactiveReviewScheduler({ now: () => clock });
  const config = { enabled: true, cooldownMs: 100, budget: { runsPerDay: 2 }, concurrency: 2 };
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'a', config }).action,
    'review',
  );
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.rebuilt', sourceVersion: 'b', config }).reason,
    'cooldown',
  );
  scheduler.release('w');
  clock += 1_000;
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.rebuilt', sourceVersion: 'b', config }).action,
    'review',
  );
  scheduler.release('w');
  clock += 1_000;
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.rebuilt', sourceVersion: 'c', config }).reason,
    'budget',
  );
});

test('one in-flight review holds the concurrency slot until it is released', () => {
  const scheduler = createProactiveReviewScheduler();
  const config = { enabled: true, cooldownMs: 0, budget: { runsPerDay: 10 }, concurrency: 1 };
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'a', config }).action,
    'review',
  );
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'b', config }).reason,
    'concurrency',
  );
  scheduler.release('w');
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'b', config }).action,
    'review',
  );
});

test('disabled or untriggered facts never start anything', () => {
  const scheduler = createProactiveReviewScheduler();
  assert.equal(scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', config: null }).reason, 'disabled');
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.rebuilt', config: { enabled: false } }).reason,
    'disabled',
  );
  assert.equal(
    scheduler.decide({
      workspace: 'w',
      trigger: 'knowledge.rebuilt',
      config: { enabled: true, triggers: ['knowledge.ingested'] },
    }).reason,
    'trigger_disabled',
  );
});

test('the proactive objective names the evidence the scan already found', () => {
  const objective = buildProactiveReviewObjective({
    trigger: 'knowledge.stale',
    sourceVersion: 'sha-9',
    evidence: {
      kind: 'stale',
      counts: { aged: 1, vanishedArchive: 1, vanishedPage: 57 },
      items: [
        { kind: 'aged', path: 'raw/ingested/a.md' },
        { kind: 'vanished-page', path: 'wiki/concepts/saas/gone.md' },
      ],
    },
  });
  assert.match(objective, /audit the workspace/);
  assert.match(objective, /knowledge\.stale/);
  assert.match(objective, /sha-9/);
  assert.match(objective, /1 aged source\(s\)/);
  assert.match(objective, /1 vanished archive\(s\)/);
  assert.match(objective, /57 vanished page\(s\)/);
  assert.match(objective, /raw\/ingested\/a\.md/);
  assert.match(objective, /wiki\/concepts\/saas\/gone\.md/);
  // Routing is explicit (capabilityPlan), so an evidence path may contain any
  // word — the alias resolver is no longer on the path.
  const noEvidence = buildProactiveReviewObjective({ trigger: 'knowledge.ingested', sourceVersion: 'v1' });
  assert.match(noEvidence, /audit the workspace/);
  assert.doesNotMatch(noEvidence, /deterministic scan/);
});

test('reading the budget, or releasing an unknown workspace, never allocates', () => {
  const scheduler = createProactiveReviewScheduler();
  assert.deepEqual(scheduler.snapshot('never-seen'), {
    lastFiredAt: null, runsToday: 0, inFlight: 0, inFlightTrigger: null, seenVersions: 0,
  });
  scheduler.release('never-seen');
  scheduler.release('never-seen', { undo: true });
  assert.equal(scheduler.workspaceCount(), 0);
});

test('the seen set is pruned with the daily window, not grown forever', () => {
  let clock = 1_000_000;
  const scheduler = createProactiveReviewScheduler({ now: () => clock });
  const config = { enabled: true, cooldownMs: 0, budget: { runsPerDay: 10 }, concurrency: 5 };
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'v1', config }).action,
    'review',
  );
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'v1', config }).reason,
    'duplicate',
  );
  // The window rolls: dedup starts clean rather than holding every version ever.
  clock += 24 * 60 * 60 * 1000;
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'v1', config }).action,
    'review',
  );
});

test('an undone reservation returns the budget unit and the version', () => {
  const scheduler = createProactiveReviewScheduler();
  const config = { enabled: true, cooldownMs: 0, budget: { runsPerDay: 1 }, concurrency: 1 };
  assert.equal(
    scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'v1', config }).action,
    'review',
  );
  scheduler.release('w', { undo: true, sourceVersion: 'v1' });
  // Neither the budget nor the version was consumed: the audit can still happen.
  const again = scheduler.decide({ workspace: 'w', trigger: 'knowledge.ingested', sourceVersion: 'v1', config });
  assert.equal(again.action, 'review');
});

test('the in-flight review names itself, so a skip can say who holds the slot', () => {
  const scheduler = createProactiveReviewScheduler();
  const config = { enabled: true, cooldownMs: 0, budget: { runsPerDay: 10 }, concurrency: 1 };
  scheduler.decide({ workspace: 'w', trigger: 'knowledge.conflict_detected', sourceVersion: 'f1', config });
  assert.equal(scheduler.snapshot('w').inFlightTrigger, 'knowledge.conflict_detected');
  scheduler.release('w');
  assert.equal(scheduler.snapshot('w').inFlightTrigger, null);
});
