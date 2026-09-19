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
  there, web search tools.
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
        "aliases": ["notify", "report", "email"],
        "defaultRequiresApproval": true }
    ] }
] }
```

Capability fields: `name`, `operations`, `description` (the general, language-
agnostic route: the LLM resolver matches any-language objectives against it),
`aliases` (the deterministic fast path, single-language), and the governance
pair `mutationClass` / `defaultRequiresApproval` — propagated to the synthetic
agent so `buildExecutorOnlyFragment` produces approval-gated tasks like any
other executor. The verbs of a read-only analysis are **aliases of one
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
  and a concurrency ceiling (default 1);
- the workspace opts in through `proactiveReviews` in `.wikirc.yaml`
  (`{ enabled, triggers, cooldownMs, budget: { runsPerDay }, concurrency }`).
  Anything missing or malformed is DISABLED, and every refusal is logged;
- an accepted trigger queues an `agent.review` through the normal control lane.
  The objective carries ONLY the `audit` alias — the resolver returns null when
  two capability aliases match, and `agent.notify` owns `report`, `agent.curate`
  owns `clean`/`fix`. The run is read-only: no worktree, no mutation, no
  external message;
- the result is FILED as a note in `<workspace>/.wiki/agent-reviews/<id>.json`
  (`{ id, workspace, trigger, createdAt, status, summary, findings,
  sourceVersion, budget }`) and announced in the Activity/logs. It never goes
  to `.wiki/agent-proposals/`, which exists to be merged.

The review's concurrency slot is released when its run reaches any terminal
state, and the marker rides on the persisted control item — so a runtime
restart re-attaches a queued review instead of losing it or running it twice.

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
  the proposal; it never writes wiki content.

  Gateway-side ceilings for the hands (all optional, defaults in
  parentheses): `GATEWAY_RECURSION_LIMIT` (40) graph steps, `GATEWAY_TOKEN_BUDGET`
  (500 000) estimated tokens, `GATEWAY_WORKTREE_MAX_FILES` (40) /
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
