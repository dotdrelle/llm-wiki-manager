# Agentic runtime

The manager can route open-ended, analysis-style objectives to an **external
agentic runtime** (Deep Agents or another), alongside the deterministic
orchestration it already provides. This document is for whoever deploys or
changes that integration; the user-facing view is `help-doc/12-agentic-runtime.md`
in the `llm-wiki` repository.

## The model in one sentence

The runtime has **eyes, ideas and a mouth** (read tools, open reasoning, and
side-effects such as email — all under approval) but **no hands on the
workspace**: the hands are the DAG, and there is one pair per workspace.

- **Eyes** — the runtime's own MCP pool: wiki read tools, and, when declared
  there, web search tools. The pool travels with each run
  (`activeProfileMcp`) and the run's system prompt is built from that same pool
  (`activeRuntimeSystemPrompt`): it says the workspace wiki is searched
  **first**, then names the declared external read tools. A prompt that denies
  a tool the pool carries is the defect — observed on acpi, `agent.answer`
  answered "je suis limité aux seules sources du wiki" to "cherche sur
  internet" with an external web-search connector connected, making zero tool
  calls, while its own declared description promised web search.
- **Ideas** — free reasoning, sub-agents, memory: everything the engine does
  internally.
- **Mouth** — side-effects on the outside world (email), gated by the
  runtime's human-in-the-loop, which the manager unblocks only after a human
  grant.
- **Hands** — the deterministic DAG (scheduler + production agent). The
  runtime never reaches it directly: structural changes are **proposals**
  (`planExpansionRequest`) that the manager integrates into the active run's
  plan, under the normal approval and lock rules.

## Components

```text
agent-runtimes.json          declaration (id, type, endpoint, capabilities)
src/orchestrator/providers/
  runtimeProvider.js         the RuntimeProvider contract (7 methods)
  runtimeProviders.js        discovery, config resolution, synthetic agents
  fakeRuntimeProvider.js     in-process provider (tests, plumbery, HITL demo)
  deepAgentsProvider.js      HTTP client (RFC § 11 option A)
src/core/runtimeEventAdapter.js   RuntimeEvent -> manager events
```

- Discovery runs at boot and on the periodic re-scan
  (`discoverRuntimeProvidersOnce`, wired next to `discoverAgentsOnce`).
  Declared capabilities become **synthetic agents** in the same capability
  registry as MCP agents: routing, resolution and dispatch are unchanged.
- A down runtime yields no agents: its capabilities are absent, the DAGs are
  unaffected, and the degradation is announced **once** in the journal
  (edge-triggered, not per re-scan).
- `/status` shows a `Agentic runtime` section (`id`, health, capabilities) and
  re-reads `agent-runtimes.json` on every call, so a config change is visible
  without a restart.

## Declaration

`agent-runtimes.json` in the manager state directory (seeded from the packaged
`agent-runtimes.example.json`, enabled by default — the scaffold ships
`GATEWAY_ENABLED=true`, opt out with `false` in either file). One entry per
runtime:

```json
{ "runtimes": [
  { "id": "deepagents",
    "type": "deepagents",
    "endpoint": "http://localhost:7789",
    "enabled": true,
    "capabilities": [
      { "name": "agent.review",
        "operations": ["run"],
        "description": "Read-only audit of a wiki workspace… No mutation.",
        "aliases": ["audit", "review", "analyze", "compare", "check"] },
      { "name": "agent.research",
        "operations": ["run"],
        "description": "Web research grounded in the wiki; writes findings into the inbox. Mutation, approval required.",
        "aliases": ["research", "investigate", "answer"],
        "mutationClass": "ingest" },
      { "name": "agent.notify",
        "operations": ["run"],
        "description": "Read the workspace profile for the notification recipient, then send a report by email. Mutation, approval required.",
        "aliases": ["notify", "send", "email"],
        "defaultRequiresApproval": true }
    ] }
] }
```

Capability fields: `name`, `operations`, `description` (the general, language-
agnostic route: the LLM resolver matches any-language objectives against it),
`aliases` (the deterministic fast path, single-language), `subagents` (the
declared collective, propagated to the synthetic agent so the dispatcher knows
the role total from the start), `worktree` (confined hands — see Governance),
and the governance pair `mutationClass` / `defaultRequiresApproval` —
propagated to the synthetic agent so `buildExecutorOnlyFragment` produces
approval-gated tasks like any other executor. The verbs of a read-only analysis are **aliases of one
capability**; a capability is split only when the governance profile changes.

The declaration is what the manager *routes on*; what the runtime *serves* is
observed, never assumed. Discovery always calls `GET /capabilities` and offers
only the capabilities **both** declare (the configured entry's metadata wins,
so `mutationClass` / aliases stay authoritative). A configured capability the
gateway does not serve is a **drift**: it is not routable (`capability_not_found`
rather than an ungoverned run), `/status` lists it under "not served by the
gateway", and the runtime log announces it once — the usual cause is the
gateway's `/config` mount hiding `agent-runtimes.json`. Symmetrically the
gateway refuses (`400`) any `POST /runs` naming a capability or operation it
does not serve, so a run can never fall outside the approval gate by name.

## Operations

A capability's `operations` is its closed vocabulary of machine verbs —
required by the shared capability contract, and doing three jobs even when it
holds a single value:

- **validation**: `resolveObjective` refuses an operation outside the list;
- **default routing**: `operations[0]` is used when none is named, which is
  what makes `run` optional in `/run capability <id>`;
- **extension without migration**: a longer list later changes no manager code.

Existing vocabulary on the deterministic side: `knowledge.pipeline` declares
`ingest`, `build`, `export`, `polish` (0.15.66 removed the retired concept
steps); `workspace.diagnose` is its own capability.

Agentic capabilities ship with `["run"]` (execute end-to-end). Add an
operation only when the runtime genuinely acts differently **and** the verb is
routable; depth or style is a parameter of the objective, never an operation.
Useful values: `plan` (produce the analysis, stop before any mutation),
`preview`/`send`, `answer`/`write`.

Two governance rules, now declared in the packaged example's `_comment` keys:

1. **`plan` is always a dry-run**: it never pauses for approval, even on a
   mutating capability — the fake simulates this, and a real runtime must
   honour it.
2. **Read/write pairs are two capabilities**, not two operations on one: the
   approval class is per-capability, so a mixed capability would blur the
   DAG-side governance (the runtime's own human-in-the-loop is already
   operation-aware). `agent.preview` + `agent.notify`, `agent.answer` +
   `agent.research`.

`aliasOperations` maps a user alias to a specific operation when several
exist (`{ "plan": "plan", "apply": "run" }`); it is propagated like
`mutationClass`. Without it, the deterministic resolver falls back to
`operations[0]`.

## Memory

The runtime keeps a **conversation memory per workspace**: the manager sends
the workspace with every run and the gateway checkpoints the MAIN thread under
`thread_id = <memory scope>` (`memory.sqlite` in its config dir, SqliteSaver).
A run therefore resumes its workspace's previous thread across runs and across
gateway restarts; a request without a workspace lands on `default`.

**The scope is a read capability, so the gateway owns it.** `memoryScope`
travels on the run request (`RuntimeExecuteRequest` → `DeepAgentsProvider.execute`
→ the `/runs` body), and the gateway validates it against the workspace it
resolved for the run: a scope may only REFINE that workspace
(`<workspace>:<actorId>`, the shape the multi-user lot will fill), never leave
it. A value that does, or that is malformed or oversized, falls back to the
workspace and emits a `degraded` event. An ABSENT scope is the normal
single-user case and says nothing — there is no actor to name yet.

**The collective's role threads are bounded to one run**
(`<workspace>:<runId>:<role>`), deliberately not derived from the main thread.
They used to be, so making the main thread stable would have made them stable
too — and a Critique that re-raises an objection settled three runs ago, or a
Scout that accumulates every past run's findings, degrades the collective
instead of helping it. The main thread carries the workspace's memory; the
role threads carry one curation, and their checkpoints are deleted once the
role finishes — bounded to the run means no reader afterwards.

**Manager conversation memory is a separate, read-only input.** Before each
agent run, the manager retrieves a bounded set of relevant, evidence-linked
facts from its workspace SQLite store and appends them to the runtime system
prompt as `trusted="false"` data. The gateway may use them as prior context,
but current wiki/tool results win on conflict; the gateway does not write them
back into its own checkpoints or dossier. No chat transcript is sent as part
of this projection. If retrieval fails or falls back from configured vector
search to lexical search, the manager announces that in Activity Logs.

The memory is bounded so `memory.sqlite` cannot grow without end: a
**workspace dossier** (the Archivist's factual memory + unresolved objections,
in its own table of the same file) is what survives, injected into the next run
as a bounded `## Workspace memory` section; the main thread is **compacted**
past `GATEWAY_MEMORY_MAX_CHECKPOINTS` (default 200) and **evicted** for
workspaces untouched for `GATEWAY_MEMORY_TTL_MS` (default 30 days). Compaction
and eviction are `notice` events, not failures; a missing volume is a
`degraded` and the run continues without memory.

The dossier **merges**, it never replaces: an empty run keeps the previous
summary (so an optional Archivist that failed cannot erase the workspace's
memory) and objections accumulate, deduplicated on path+statement. An objection
is closed only EXPLICITLY — the Archivist repeats it as
`[resolved] <path> — <statement>` — because a run that does not mention an
objection has ignored it, not resolved it. The cap drops the stalest, never the
freshest, and announces what it abandoned with a `notice memory.capped` — a
silent cap would repeat the defect the merge rule exists to prevent.

## Activity and liveness

The gateway emits structured facts, never private reasoning. The adapter maps
them to the manager's vocabulary; `runtime_log` and `runtime_heartbeat` are
SSE-only and never persisted:

- `phase_started` / `phase_finished` — bounded, carrying the tool/page counters
  the phase used. They enrich the EXISTING business activity line and its
  `projectWorkflow`, never a second axis of "phases".
- `progress` — coalesced by the gateway (one frame per window, not one per
  tool); the phase close always carries the final counts.
- `heartbeat` — liveness while a long, tool-less phase runs. It becomes a
  NON-persisted `runtime_heartbeat` event: the serve run strip reads it (elapsed
  since the last beat) and it restarts the in-flight watchdog. It never reaches
  the journal — one line per beat would bury what actually happened.
- `finding` — one per `[objection]` line, carrying severity, role and the page
  path as structured fields, then the bounded statement.
- `subagent_started` / `subagent_finished` — the collective's roles; the
  dispatcher turns them into the external activity's percent/label
  (`externalRoleProgress`: finished over declared/known roles, capped below 100
  until the task ends; with no declared `subagents` list it names the role
  instead of inventing a percentage).
- `degraded` — a refused memory scope, a role that failed, a capability
  fallback. Always surfaced, and carried on the run RESULT so a proposal opened
  later still says what was lost when it was written.

The collective declares its roles required or optional: Scout and Analyst are
required (without material the Redactor writes about nothing), Critique and
Archivist are optional, and Redactor is required only when a worktree is armed.
An optional role's failure emits `degraded`, keeps the roles already finished
and does NOT remove the worktree; a required role's failure removes the branch
nobody will review.

## Transport and compatibility

The SSE subscription is a cursor protocol, not a fire hose:

- the gateway's first frame is `stream_epoch`, one identity per process. The
  provider sends the last `sequence` it saw (`?after=`) and the epoch it saw
  (`?epoch=`) on every reconnect; the gateway replays strictly after the cursor.
  A different epoch means the gateway restarted: the manager refuses the mixed
  history and is told (a `degraded`), it does not silently resume on a gap.
- the gateway bounds `run.events` (`GATEWAY_MAX_RUN_EVENTS`, default 5000) and
  purges finished runs after `GATEWAY_RUN_TTL_MS` (default 10 min). A cursor
  older than what the buffer retains is told events were lost.
- the manager reconnects with bounded backoff
  (`WIKI_MANAGER_RUNTIME_STREAM_RETRIES` / `..._STREAM_BACKOFF_MS`, default 5 /
  250 ms). The budget resets on PROGRESS (an advanced cursor), never on a mere
  HTTP 200 — a flapping stream must not loop forever. Giving up, a 404 on a
  purged run, and a malformed frame are all announced, not swallowed.

Matrix (fields and types added remain OPTIONAL until a coordinated version
bump; nothing here requires a same-second deploy):

| Manager | Gateway | Behaviour |
| --- | --- | --- |
| same | same | Full: liveness, phases, cursor replay. |
| new | old | Fine. The old gateway emits legacy types only; absent optional fields default, and its missing `stream_epoch` simply means no restart detection. |
| old | new | **Upgrade the manager first.** The old manager's closed `runtimeEvent` contract rejected event types it did not know before its adapter could journal them, so the new activity (phases, heartbeat, findings) is invisible to it. It still runs — `memoryScope` and the cursor query params are optional to the gateway. |

## Proactive reviews (opt-in)

A successful ingest or rebuild publishes a stable business fact
(`knowledge.ingested` / `knowledge.rebuilt`), derived in `resultAggregator` from
the task's capability/operation, and hands it to a trigger hook. The runtime's
`proactiveReviewScheduler` decides, deterministically, whether the fact is
worth a read-only audit:

- dedup per `(workspace, trigger, sourceVersion)`, a cooldown, a per-day budget
  and a global concurrency ceiling of 1 across workspaces. Spend, cooldown and
  seen versions survive restart in the runtime SQLite database; pending slots
  are reconciled from the persisted control queue, including recovered runs.
  The workspace concurrency setting cannot raise the global ceiling;
- the workspace opts in through `proactiveReviews` in `.wikirc.yaml`
  (`{ enabled, triggers, cooldownMs, budget: { runsPerDay }, concurrency }`).
  Anything missing or malformed is DISABLED, and every refusal is logged;
- beyond task facts, a deterministic CORPUS read runs when an ingest/rebuild
  completes: a tag filed into multiple families or a concept pivot with no
  fiche citations publishes `knowledge.conflict_detected` with a stable
  fingerprint computed over the FULL conflict set — the display ceiling (50)
  names what it hides and never freezes the version, so a later conflict still
  moves it. The scan runs ONLY when the workspace opted in (never on the
  default), reads family/tag metadata and fiche citations, and uses no model.
  When the conflict review takes the only concurrency slot, the ingest fact's
  skip says so by name. A second
  deterministic read publishes `knowledge.stale` from the engine's source
  registry: it names an active source whose `lastIngestedAt` is older than
  `staleAfterDays` (default 180), any registry path that no longer exists — a
  vanished archive or a vanished produced page — AND any wiki page no ACTIVE
  source backs (an orphan: hand-written or pre-registry pages included, a
  provenance gap the operator is asked about). Engine-owned pages are never
  orphans: `wiki/index.md`, `wiki/log.md` and generated TAXO pivots
  (`wiki/concepts/**` with `by: llm-wiki-tags`) are excluded, mirroring the
  engine's doctor; an unreadable page is still reported. Existence and a join on
  the registry, never a mirrored reconciliation algorithm;
- an accepted trigger queues an `agent.review` through the normal control lane
  with an EXPLICIT `capabilityPlan` naming the capability: the objective names
  evidence PATHS, which could contain another capability's alias (`report`,
  `plan`, `check`…), and the free-text resolver returns null on two hits — so
  routing never depends on the text. The run is read-only: no worktree, no
  mutation, no external message;
- the detector's exact facts travel with the review: named in the objective and
  persisted on `.wiki/agent-reviews/<id>.json` as `evidence`. A fingerprint
  alone would make the agent re-read the whole wiki to rediscover what the scan
  already established — and a vanished page is an absence, which reading cannot
  find;
- the result is FILED as a note in `<workspace>/.wiki/agent-reviews/<id>.json`
  (`{ id, workspace, trigger, createdAt, status, summary, findings,
  sourceVersion, budget, evidence }`) and announced in the Activity/logs. It
  never goes to `.wiki/agent-proposals/`, which exists to be merged;
- a periodic clock (`WIKI_MANAGER_CORPUS_SCAN_INTERVAL_MS`, default 15 min)
  runs the stale read ALONE: `aged` is caused by time, and a workspace that
  stops ingesting — precisely the one whose knowledge ages — would otherwise
  never re-run the detector.

The review's concurrency slot is released when its run reaches any terminal
state, and the marker rides on the persisted control item — so a runtime
restart re-attaches a queued review instead of losing it or running it twice.

## Automatic maintenance (`agent.maintain`)

The one runtime capability with hands, and they are narrow. Code:
`src/maintenance/` (manager), `src/maintenance.js` (gateway); user view:
`llm-wiki/help-doc/14-maintenance.md`; keys: `docs/configuration.md` §
`maintenanceAccess`.

**Who owns what.** The manager owns the policy, the human decisions
(`maintenance_requests`), the budgets (`maintenance_reservations`, reserved
atomically at admission and settled once), the cycles and the durable event
history — all in the runtime SQLite. The gateway owns the cycle's reasoning and
its own journal (`maintenance_gateway_runs` in `memory.sqlite`). The engine
owns the facts (`wiki_maintenance_state`: pending sources and their
protection, deliverable/publication freshness, index freshness) and never
stores a decision or a budget.

**How a scan runs** (`tick`, every `WIKI_MANAGER_MAINTENANCE_INTERVAL_MS` and
after an ingest/rebuild completes):

1. An interrupted cycle is re-attached first.
2. Routine work — `sync`, `doctor`, `mail` — is run by the manager itself
   through `runCandidate`, with no model call and no gateway.
3. Only if other work remains is a gateway cycle started
   (`agent.maintain`, operation `run`), with a per-cycle bearer secret and the
   bridge URL. The gateway reads `state` (routine work filtered out) and calls
   one tool per action; each tool calls back `POST /maintenance/bridge`
   (`command: action`), where the manager re-validates the candidate, the
   current policy version, the exact approval, the budget and the admission,
   then dispatches through the agents' `agent_execute`/`agent_status` with an
   `idempotencyKey`. The gateway never holds an agent credential.
   The gateway sends `async: true`: the manager answers `202 {ticket}` at once
   and runs the action bound to the runtime's lifetime, not to the request;
   the gateway polls `command: action_status` (1 s → 10 s) until `settled` or
   `failed`. Holding one request for a whole job outlived fetch's 300 s header
   timeout — a 44-source ingest read "fetch failed" while it went on, and the
   closed connection aborted the manager's own follow-up. A gateway that omits
   `async` still gets the former synchronous answer.

**Admission** (`src/maintenance/admission.js`) is shared with Donna's
dispatcher (`dispatcher.execute`). Maintenance actions take scopes derived from
what they touch (`workspace-write` for ingest/rebuild/index, `template:` /
`deliverable:` for build/deliver, `raw/untracked` for sync); doctor, curate and
mail take none. The user has priority:

- maintenance starts nothing that writes while a user run has unfinished tasks
  **or** a user request is queued (`foreground_run_pending`,
  `foreground_queue_pending`), and a user task registered before a maintenance
  start wins;
- a started job of a **preemptible** action (`PREEMPTIBLE` in `service.js`:
  sync, ingest, index, rebuild, build — replaying them leaves nothing half done)
  is stopped when a user task waits on it: admission calls the holder's
  `onPreempt` once, the service sends `agent_cancel`, the attempt is settled
  `released` with `outcome: cancelled, preempted: true` (its credit returned),
  and the next scan replays it under a new `:retry-N` id — a new idempotency
  key, so the agent cannot answer with the cancelled job. A deliver (an
  existing export update) or a mail is never interrupted: whether it took
  effect would be unknown; the user task waits for it;
- every action has a fixed time limit (`ACTION_CEILING_MINUTES`, not a
  setting: sync 30 min, ingest 120, index 60, rebuild 180, build 60, deliver 30,
  doctor 15, curate 90); past it the job is cancelled and reported `failed`
  ("stopped after N min without finishing"). An agent that does not confirm a
  stop within 2 minutes leaves the reservation held for reconciliation
  (`maintenance_cancel_unconfirmed`).

Every wait is logged (`scheduler: waiting for maintenance — …`) and, for a run
task, published as an `admission:<taskId>` activity (`source: scheduler`,
`status: queued`) so the run strip and the Plan tab read "Waiting for
maintenance — <action>" instead of "Running · 0%"; it turns `done` when the task
starts. Production locks stay authoritative underneath. The CME agent refuses
an export whose Confluence does not accept a TCP connection within 5 s, so an
unreachable instance fails fast instead of holding `raw/untracked`.

**Recovery and durable accounting.** Each scan first queries every reserved
job receipt, even if its candidate disappeared because the job archived the
sources or refreshed the output. Terminal outcomes, proposals and budgets are
settled once; jobs still running or effects without a known receipt retain
capacity and prevent new starts. The current capability contract is resolved
again after admission waits, before any dispatch. Email alert watermarks remain
manager metadata and never enter the connector's closed argument schema.

Each model invocation carries a UUID rather than a cycle-local counter, so
recreating a gateway runner cannot reuse a consumed credit. Replaying the same
admission or settlement remains idempotent. Terminal maintenance status and
cycle replay are resolved from the gateway SQLite journal after the bounded
in-memory event buffer expires; the finished timestamp and failure status are
persisted at every exit.

**Active-run visibility.** An executing maintenance action or cycle counts in
`activeRuns` (`/health`) and in the 409 guards of `POST /config/use` and
`POST /mcp/endpoints`, so a config or connector change never lands under it and
the shell keeps the runtime alive at exit.

**Memory.** The cycle runs with `memoryScope` and `dossierScope`
`<workspace>:maintenance`: it neither interleaves with the curation thread nor
reads or folds the collective's dossier.

**Shutdown is not Stop.** `close()` aborts the manager's waits, not the jobs:
a started job keeps its held reservation and is followed again at the next
boot. `/maintenance stop` (or `runtime__maintenance_stop`) cancels the cycle
and its jobs and pauses. Donna's tools can read, pause and stop; none approves.

**Proactive reviews are separate.** They keep their own opt-in, dedup key and
`.wiki/agent-reviews/` output; a corpus trigger feeds both schedulers.

## Progressive final stream (lot 7 — not enabled)

The adapter accepts `assistant_delta` / `assistant_delta_reset` from a runtime,
and the reducer REPLACES the streamed text with the final `assistant_message`
(`finalizeAssistantMessage`), so streaming cannot duplicate the answer. The
consumer side is ready. The gateway does NOT stream yet, and the note is
deliberately careful: the JS hook is `_streamResponseChunks` (an earlier note
probed `_stream`, the Python name, and was wrong), and the graph calls it when
the model implements it — but whether it SURFACES per-token frames depends on
the node's own invoke/stream branch, and our probes aggregated to one frame. So
feasibility is NOT established; read that branch and prove it with a real
integration test. The reason to defer regardless is SCOPE: only the ASSEMBLY
has a visible answer (a role's output is a handoff the user never sees), so a
stream would accelerate one phase, not the run.

## Governance


- Read-only analysis: free, no approval.
- Direct side-effects (email): the runtime emits `approval_required` with a
  `proposal` (read tools + announced mutations). The adapter turns it into a
  native `approval.requested` (classes derived from the mutations); the
  dispatcher waits on the existing `approvalCovered()` until a human grant
  (`/approve`, run scope) arrives, then calls `runtimeProvider.approve()` to
  unblock the runtime's human-in-the-loop. The task timeout does not run while
  the decision is pending. Every announced class must be covered: the "global"
  approval is bounded by the proposal; stepping outside re-pauses.
- Structural changes: the runtime's result carries a `planExpansionRequest`;
  `resultAggregator` resolves the target capability, calls its `agent_plan`,
  validates and integrates the fragment into the **same run**, with
  `enforceApprovalCoverage`. The runtime never touches the scheduler.
- **Worktree proposals** (`worktree: true`, today `agent.curate`): the runtime
  gets confined hands on a git worktree branch (one per objective, canonical
  path check on every operation) and its result carries a `worktreeProposal`
  (changed files, their new content, unified diff). `resultAggregator` persists
  it into `<workspace>/.wiki/agent-proposals/<taskId>.json` and announces it in
  the runtime log — the served review page (`/agent-proposals` in `wiki serve`)
  is where the human MERGES (write through the engine + history commit) or
  rejects (worktree removed). The merge IS the approval: the capability
  declares no `mutationClass`, so no pre-run pause. The manager only RECORDS
  the proposal; it never writes wiki content. A `worktreeProposal` with zero
  changed files is a FAILURE, not a proposal: the task returns `ok:false` with
  the runtime's degradation causes and the message that its report describes
  corrections that were never written; nothing is filed for review. One
  exception: a result carrying `curationOutcome: {kind: "rebuild_owned",
  reason}` — the Redactor ended on a `[rebuild-owned] <reason>` line because
  every finding sits on a generated `wiki/concepts/` pivot. That task
  completes, nothing is filed, and the run outcome tells Donna there is
  nothing to review and that `/wiki-rebuild` is the next step.

  Gateway-side ceilings for the hands (all optional, defaults in
  parentheses): `GATEWAY_RECURSION_LIMIT` (40) graph steps, `GATEWAY_TOKEN_BUDGET`
  (2 000 000) estimated tokens, `GATEWAY_WORKTREE_MAX_FILES` (40) /
  `GATEWAY_WORKTREE_MAX_DIFF_CHARS` (300 000) — beyond them the run fails
  loudly and discards the branch instead of queueing an unreadable review —
  and `GATEWAY_WORKTREE_MAX_AGE_MS` (7 days), after which a startup prune
  removes worktrees nobody merged or rejected. The collective (`subagents: [...]`
  per capability, in `agent-runtimes.json`) runs the named roles — Scout,
  Analyst, Critique, Redactor, Archivist — as bounded sequential runs with
  per-role tool allow-lists; the Critique's structured `[objection]` lines
  travel with the proposal and never block it.
- One active run per workspace (`context.running` + the control lane), and
  per-run locks, keep the deterministic path authoritative even if the runtime
  proposes and the user asks at the same time.

## Invariants (do not change)

- The DAG, scheduler, dispatcher, capability resolver, skills and the approval
  model are **untouched** — the runtime rides the existing registry and the
  existing grants.
- `runtimeProvider.approve` is a **downstream unblock signal**, never an
  approval surface: its only caller is the dispatcher, after
  `approvalCovered()`. Never expose it as a tool or an endpoint — that would
  re-create the removed self-approval path.
- The runtime's MCP pool is **read-only plus scoped, approval-gated tools**
  (email). Never give it `agent_execute`, `agent_plan`,
  `production_start_job`, or any write path to the workspace.
- Capability names, aliases, descriptions and classes come from
  **configuration**, never from manager code. A new MCP or a new engine
  tomorrow is a new config entry, not a code change.

## The three execution modes

| Mode | Engine | What it is for |
|------|--------|----------------|
| Chat | direct LLM, `chatAccess` allow-list | know, check, understand |
| Agent | Donna's bounded tool loop + delegation | run a known operation (DAG) |
| Agentic | external runtime behind a capability | open analysis, judgement, proposals |

RAG feeds the eyes (retrieval read tools); the orchestration is the hands; the
agentic runtime is the analyst; DONNA is the single conversational surface and
the governor that routes, integrates and applies the approval rules.

## Objective supervisor (structured runs)

`runtime/objectiveSupervisor.js` is the checkpoint the runner calls when a
structured run settles. It replaced the one-shot recovery below in the runner;
`recoverFailedRun` survives only as the tested core of `installRecoveryPlan`.

- **Investigate.** `orchestrationDiagnostics.js` gives the model the run facts
  (objective, every task with its status, arguments and evidence, failure
  diagnostics, published contracts, the last runtime logs, recent incidents)
  and the read-only MCP tools of the connected agents — annotation-gated,
  workspace-bound, limited to the run's own jobs, at most 3 model turns, 6 tool
  calls and 25 s. Tool output is untrusted data.
- **Decide.** `explain`, `retry` (pre-execution `invalid_arguments` only, one
  correction per task), `replan` (`adaptivePlan.js`: replace the diagnosed
  failure or append missing work, 1–6 tasks over published capabilities,
  completed tasks immutable, a repeated proposal refused), `complete` or
  `blocked`. A started mutation, a timeout or a missing authorization is never
  replayed. Mutating follow-ups need fresh revision-bound approval; read-only
  follow-ups proceed only when the capability declares `readOnly`.
- **Bound.** At most `MAX_SUPERVISOR_CHECKPOINTS` (3) per run, then an
  explicit stop with what was accomplished and what remains. Task budgets
  remain shared across revisions; a follow-up cannot replenish them. Outstanding
  failures retain their exact pre-execution evidence for later checkpoints.
- **Remember incidents.** `orchestration.checkpoint` is a bounded durable audit
  event (unlike transient `runtime_log`). The next investigation reads the last
  five incidents in that workspace, including error classes, removed argument
  names and revised capabilities; no request values, message bodies or secrets
  are copied into this incident memory. Hydration restores the reader after a
  restart; switching workspaces invalidates it until rehydration. Incident
  hints are untrusted context, never approvals or proof of a current result.
  User facts and preferences remain in the separate evidenced workspace memory.
- **Keep completed results.** Historical activity frames cannot revive a
  terminal TaskGraph task or match a newly added task by label similarity.
- **After a success** the objective check runs only when the success is not
  already established (`successCheckWarranted`): the evaluation has a doubt, or
  a mutating task succeeded without its agent's `verified` observation. A
  read-only run or a fully verified one costs no extra model call; the skip is
  logged (`orchestrator: objective check skipped`).
- **Say it through Donna.** Every supervisor notice is an English fact line
  worded by Donna in the session language (`userFacts.js`).

## Structured failure recovery in the manager

`runtime/failureRecovery.js` adds one bounded, tool-less model diagnosis after a
structured scheduler run settles. It receives the original objective, error,
selected provider input schema and exact wire arguments. The dispatcher remains
deterministic; its rejected-request context is non-enumerable and ephemeral,
so wire arguments are not duplicated into the event log. Credential-shaped
material is redacted, context and response sizes are capped, and the call has a
20-second deadline. Redacted or truncated context is diagnosis-only.

A correction is admissible only for `invalid_arguments` with an explicit
`accepted:false`, no job identifier and no active job. Existing schema-valid
fields remain verbatim. The manager fixes the capability/operation/provider,
validates the entire replacement graph against the published contracts, creates
new task identities and idempotency keys, and requires fresh revision-bound
approval even when the original run was auto-approved. Completed tasks retain
their evidence; only unexecuted skipped descendants with explicit dependencies
are revived. Group-dependent recovery is refused with a diagnostic. Historical
failed-task events remain authoritative in the audit. Cancellation, exhausted
budgets and jobs with possible effects cannot trigger this recovery.

`runtime__status` exposes up to five compact failure diagnostics with errors,
argument names and bounded input schemas; message bodies and recipient values
are not duplicated into this diagnostic view. Contract availability and omitted
context are explicit. The operational workflow is documented once in the
engine's shipped `help-doc/06-troubleshooting.md`.

Chat `/delegate` enables final evaluation. Structured evaluation remains based
on deterministic TaskGraph results, not a model's reinterpretation of success.
It consumes optional structured `verification` observations reported by agents
after action (`verified`, `not_observed`, `unavailable`, `not_applicable`). Missing
observations remain explicitly unverified. `not_observed` fails evaluation,
without replaying any action; unavailable reads preserve the execution receipt
and announce uncertainty. These facts are part of the English fact line Donna
words in the session language (`runtime/userFacts.js`); nothing is appended
raw to her sentence, and without a model the fact line itself is the message. Legacy
prose replanning is never used to replace a structured graph, including when
`WIKI_MANAGER_REPLANNER_MAX_REPLANS` is explicitly enabled. Independent
post-action verification belongs to the executing provider, not a business-specific
manager tool call. The connectors provider reads the exact acknowledged Gmail
message ID with `format=minimal`, checking its ID and `SENT` label (10-second
HTTP deadline, no send retry on read failure). This observes Sent presence,
not delivery to the recipient. A send-only grant still works but cannot verify.
Dry runs contact no provider and are marked `not_applicable`. Collection reads
back the final unique output paths byte-for-byte and reports their observed
count; this verifies raw collected files, not the subsequent ingestion/rebuild.
Verification status survives persisted idempotent replay. Other agents without
this observation contract remain explicitly unverified.

### Maintenance state and history costs

Maintenance reads TAXO concept files asynchronously in batches of 16. The
snapshot computes each recipient's successful-mail cursor once, and uses sets
for consumed action identities instead of repeatedly scanning reservation
history for every candidate. It still revalidates facts after admission.

SQLite indexes cover workspace request/status, reservation budget/cycle/status,
cycle and event queries. Request lookup and latest-request selection use scoped
SQL queries. No historical reservation or refusal is removed by this change.
`GET /maintenance?workspace=<name>&historyOffset=100` returns the next saved
history page; `POST /maintenance` with `command: "status"` accepts the same
`historyOffset`. The default page has at most 100 settled requests and 100
settled reservations, plus all pending/approved requests and reserved effects.
The `history` projection announces offset, limit, totals and `hasMore`. The
workspace `/state` projection uses the first page. This bounds payload decoding
for settled status history without removing records used by idempotence or
budget reconciliation.
