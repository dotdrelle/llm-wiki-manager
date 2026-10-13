/*
 Donna's account of the work in progress, in the session language.

 What the reader saw while a run worked was the agents' own counters
 (« stdout=90 stderr=0 · export · 100% 36s ») and, in Logs only, English tool
 notes (« Using cme.cme_source_add (workspace=…, name=…) »). Neither says what
 is happening, and no sentence written here could: the reply language is the
 workspace's (.wikirc), not the code's. So the runtime keeps the steps as DATA
 — tool, arguments, outcome, an activity's status, percent and facts — and the
 model words them, one line per step, in that language.

 progressNotes.js refused one model call per note, for cost and latency. This
 keeps that bargain by batching: a scope (a run, or an interactive turn that
 changed something) is narrated after a short quiet period, at most once per
 `minIntervalMs`, at most `maxCalls` times, and once more when it ends. A pure
 consultation (only read tools) is never narrated. Without a model, or when the
 call fails, nothing is invented: the panels keep showing the data, and the
 runtime log says why — once per scope.
*/
import { createAgentEvent, dispatchAgentEvent, dispatchRuntimeLog } from '../core/agentEvents.js';
import { sayLines } from './donnaVoice.js';
import { isSuccessful, isUnsuccessfulTerminal } from '../orchestrator/taskStatuses.js';

const OBSERVED = new Set(['user_message', 'tool_call_started', 'tool_call_result', 'activity_upserted',
  'task.completed', 'task.failed', 'run_done', 'run_error', 'run_cancelled', 'assistant_message']);
const DECLARED_VERIFICATIONS = new Set(['verified', 'not_observed', 'unavailable', 'not_applicable']);

// What the agent itself declared about the effect of its task, if anything —
// the same two places runner.js reads. Silence is not a verification status.
function declaredVerification(result) {
  const status = (result?.rawStatus?.result?.verification ?? result?.verification)?.status;
  return DECLARED_VERIFICATIONS.has(status) ? status : null;
}
const RUN_END = new Set(['run_done', 'run_error', 'run_cancelled']);
const MAX_STEPS = 12;
const MAX_FIELD = 240;

function bounded(value, limit = MAX_FIELD) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export function narrativeScopeKey(event) {
  if (event?.runId) return `run:${event.runId}`;
  if (event?.turnId) return `turn:${event.turnId}`;
  return null;
}

function activityState(status) {
  if (isSuccessful(status)) return 'done';
  if (isUnsuccessfulTerminal(status)) return 'failed';
  return 'running';
}

export function createStepNarrator({
  quietMs = 3000,
  minIntervalMs = 10_000,
  maxCalls = 8,
  maxScopes = 20,
  timeoutMs = 20_000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  now = () => Date.now(),
  replayWindowMs = 60_000,
} = {}) {
  const scopes = new Map();
  // A rehydration (redo, answer deletion) replays the whole log through the
  // same hook: old events and finished scopes must not be narrated — and paid
  // for — again.
  const finished = new Set();
  const isReplay = (event) => {
    const at = Date.parse(event?.ts ?? '');
    return Number.isFinite(at) && now() - at > replayWindowMs;
  };

  function scopeFor(key, event, session) {
    let scope = scopes.get(key);
    if (!scope) {
      scope = {
        key, session, runId: event.runId ?? null, turnId: event.runId ? null : event.turnId ?? null,
        conversationId: event.conversationId ?? null, workspace: event.workspace ?? session?.workspace ?? null,
        request: '', steps: new Map(), taskSteps: new Map(), actionable: false, ended: false, calls: 0, lastCallAt: 0,
        digest: '', narratedDigest: '', timer: null, inFlight: false, finalSent: false, announced: false,
      };
      scopes.set(key, scope);
      while (scopes.size > maxScopes) {
        const [oldest] = scopes.keys();
        clearTimer(scopes.get(oldest)?.timer);
        scopes.delete(oldest);
      }
    }
    scope.session = session ?? scope.session;
    scope.conversationId ??= event.conversationId ?? null;
    return scope;
  }

  function observe(event, session) {
    if (!event || !OBSERVED.has(event.type) || !session) return;
    const key = narrativeScopeKey(event);
    if (!key || finished.has(key) || isReplay(event)) return;
    const payload = event.payload ?? {};
    // A turn's final answer ends it; a run's answer does not (the run ends on
    // run_done/run_error/run_cancelled).
    if (event.type === 'assistant_message' && (key.startsWith('run:') || !String(payload.content ?? '').trim())) return;
    if (event.type === 'user_message' && key.startsWith('run:')) return;
    const scope = scopes.get(key) ?? (['user_message', 'tool_call_started', 'activity_upserted', 'task.completed', 'task.failed'].includes(event.type)
      ? scopeFor(key, event, session) : null);
    if (!scope) return;
    if (event.type === 'user_message') {
      scope.request = bounded(payload.content, 600);
      return;
    }
    if (event.type === 'tool_call_started') {
      // Plan bookkeeping and consultations (a status poll, a search) are not
      // steps of the work: narrated, they read "still in progress" three times.
      if (payload.internal || payload.readOnly === true) return;
      scope.steps.set(String(payload.callId ?? scope.steps.size), {
        id: String(payload.callId ?? scope.steps.size), kind: 'tool', tool: String(payload.name ?? ''),
        arguments: bounded(payload.args), state: 'running',
      });
      if (payload.readOnly !== true) scope.actionable = true;
    } else if (event.type === 'tool_call_result') {
      const step = scope.steps.get(String(payload.callId ?? ''));
      if (!step) return;
      step.state = payload.ok === false ? 'failed' : 'done';
      step.result = bounded(payload.result);
    } else if (event.type === 'activity_upserted') {
      const activity = payload.activity ?? {};
      const id = `activity:${activity.key ?? activity.id ?? scope.steps.size}`;
      const progress = activity.progress ?? {};
      const percent = Number(progress.percent ?? activity.percent);
      const taskId = event.taskId ?? activity.taskId ?? progress.stepId ?? null;
      if (taskId) scope.taskSteps.set(String(taskId), id);
      const previous = scope.steps.get(id);
      scope.steps.set(id, {
        ...(previous?.verification ? { verification: previous.verification } : {}),
        id, kind: 'activity', label: bounded(activity.label, 160), state: activityState(activity.status),
        ...(Number.isFinite(percent) ? { percent: Math.round(percent / 10) * 10 } : {}),
        // Agent facts are useful context, but progress payloads can contain
        // arbitrarily large arrays or text. Bound each step before it enters
        // the batched model prompt.
        ...(progress.facts && typeof progress.facts === 'object' ? { facts: bounded(progress.facts, 1200) } : {}),
        ...(activity.error ? { error: bounded(activity.error?.message ?? activity.error) } : {}),
      });
      scope.actionable = true;
    } else if (event.type === 'task.completed' || event.type === 'task.failed') {
      // The task's outcome joins the step that shows it (its activity), so the
      // narration says "sent, and seen in the mailbox" on the line itself —
      // not in a closing sentence about results nobody verified.
      const taskId = String(event.taskId ?? payload.taskId ?? '');
      const result = payload.result ?? {};
      const verification = declaredVerification(result);
      const failed = event.type === 'task.failed';
      const id = scope.taskSteps.get(taskId) ?? `task:${taskId}`;
      const step = scope.steps.get(id);
      if (step) {
        if (failed) step.state = 'failed';
        if (verification) step.verification = verification;
      } else {
        scope.steps.set(id, {
          id, kind: 'task', state: failed ? 'failed' : 'done',
          ...(verification ? { verification } : {}),
          ...(failed ? { error: bounded(result?.error?.message ?? result?.error ?? 'failed') } : {}),
        });
      }
      scope.actionable = true;
    } else if (RUN_END.has(event.type) || event.type === 'assistant_message') {
      scope.ended = true;
      if (event.type !== 'assistant_message') scope.outcome = event.type.replace(/^run_/, '');
    }
    // Only finished steps are worded while the scope runs: a sentence about a
    // step in progress ("1 %, section 6 of 12") goes stale between two calls,
    // while the live line and the run card already follow it. The end of the
    // scope words everything that is left.
    const digest = JSON.stringify([...scope.steps.values()].filter((step) => step.state !== 'running'));
    if (digest === scope.digest && !scope.ended) return;
    scope.digest = digest;
    schedule(scope);
  }

  function schedule(scope) {
    if (!scope.actionable || scope.finalSent || (!scope.ended && scope.digest === '[]')) {
      if (scope.ended) scopes.delete(scope.key);
      return;
    }
    clearTimer(scope.timer);
    const sinceLast = now() - scope.lastCallAt;
    const wait = scope.ended ? 500 : Math.max(quietMs, minIntervalMs - sinceLast);
    scope.timer = setTimer(() => { scope.timer = null; void narrate(scope); }, wait);
  }

  function announce(scope, reason) {
    if (scope.announced) return;
    scope.announced = true;
    dispatchRuntimeLog(scope.session, `voice: steps — ${reason}; the steps are shown as data`);
  }

  async function narrate(scope) {
    if (scope.inFlight) { scope.pending = true; return; }
    const final = scope.ended;
    if (!final && scope.calls >= maxCalls - 1) return; // the last call is kept for the end
    if (scope.digest === scope.narratedDigest && !final) return;
    const digest = scope.digest;
    scope.attemptedDigest = digest;
    const steps = [...scope.steps.values()].filter((step) => final || step.state !== 'running').slice(-MAX_STEPS);
    if (!steps.length) { finish(scope, final); return; }
    scope.inFlight = true;
    scope.calls += 1;
    scope.lastCallAt = now();
    try {
      const lines = await sayLines(scope.session, {
        kind: 'steps', request: scope.request || null, outcome: scope.outcome ?? null, steps,
        conversationId: scope.conversationId, timeoutMs,
        onDegrade: (reason) => announce(scope, reason),
      });
      if (lines) {
        scope.narratedDigest = digest;
        dispatchAgentEvent(scope.session, createAgentEvent('step_narrative', {
          origin: 'runtime',
          workspace: scope.workspace,
          conversationId: scope.conversationId,
          payload: { scope: scope.key, runId: scope.runId, turnId: scope.turnId, conversationId: scope.conversationId, final, lines },
        }));
      }
    } finally {
      scope.inFlight = false;
    }
    finish(scope, final);
  }

  function finish(scope, final) {
    if (final) {
      scope.finalSent = true;
      scopes.delete(scope.key);
      finished.add(scope.key);
      if (finished.size > 200) finished.delete(finished.values().next().value);
      return;
    }
    // Retry only on something new: a step changed during the call, or the
    // scope ended. A missing model or a failed call must not loop.
    if (scope.pending || scope.ended || scope.digest !== scope.attemptedDigest) {
      scope.pending = false;
      schedule(scope);
    }
  }

  return {
    observe,
    // Test and shutdown hook.
    size: () => scopes.size,
    stop: () => { for (const scope of scopes.values()) clearTimer(scope.timer); scopes.clear(); },
  };
}
