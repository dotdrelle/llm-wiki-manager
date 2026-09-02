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
the workspace with every run and the gateway checkpoints each thread under
`thread_id = workspace` (`memory.sqlite` in its config dir, SqliteSaver). A
run therefore resumes its workspace's previous thread across runs and across
gateway restarts; a request without a workspace lands on `default`.

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
