# Repository Guide

Current coordinated release: **0.15.45** (see `package.json`, the only source
of truth — this line keeps drifting, so trust the file, not the prose). Keep
manager handshakes and the local `llm-wiki` engine version aligned across the
coordinated repositories; `npm run check-versions` covers the fifteen places a
version appears, skipping any sibling repository that is not checked out.

## Purpose

`llm-wiki-manager` orchestrates multiple `llm-wiki` workspaces. It owns
workspace registration, Docker Compose wiring, MCP endpoint coordination, and
the `donna` agent shell.

Keep it a manager. Do not absorb responsibilities from `llm-wiki`,
`agent-cme`, `agent-wiki-production`, or other external agents.

Multi-repo context lives in `CLAUDE.md` at the wikiLLM workspace root (one
level above this repo, not versioned here). The master plans that drove the
"agnostic orchestration of Donna" refactor were removed once implemented; that
refactor is **fully implemented in this repo** (corrective release + ordered
commits `f1e4090`…`fd744de`):

- Donna's core is business-agnostic. It never branches on operations or agent
  names; it only understands capabilities, tasks, dependencies, groups,
  barriers, assignments, attempts, results, locks, approvals and budgets.
- Agents are discovered via `agent_describe` and indexed in the capability
  registry (`src/orchestrator/agentRegistry.js`, `capabilityRegistry.js`);
  `capabilityResolver.js` picks an instance per task from
  `requiredCapability` + workspace `capabilityRouting` config. The old
  text-similarity `selectExecutorForStep` is gone — never reintroduce fuzzy
  executor selection or a first-available-tool fallback.
- Agent-proposed `TaskGraphFragment`s pass through `planValidator.js` (13 DAG/
  contract/budget checks) then `planIntegrator.js` (revisions, events,
  persistence). Dynamic expansion via `TaskResult.planExpansionRequest`.
- Tasks execute through `dispatcher.js`/`assignmentManager.js`/
  `attemptManager.js` calling `agent_execute`/`agent_status`/`agent_cancel` —
  **no per-task LLM loop** (`runParallelTask`/`createTaskSession` were
  deleted; never recreate child agentic sessions per task). Retries can fall
  back to another instance of the same capability.
- Approvals are bounded `ApprovalGrant`s (run + revision + approval classes);
  conversation is decoupled from execution (`conversationBusy` vs
  `executionActive` in `src/shell/useSession.ts`) so the chat stays available
  during runs and extra runs are queued.
- `src/runtime/recoveryManager.js` re-attaches active tasks at boot via
  `agent_status`: terminal jobs get their results aggregated; still-active
  tasks with an `idempotencyKey` go back to `pending` for idempotent
  rescheduling.

0.11.0 was the industrialized single-user baseline; the agnostic-orchestration
work landed in the 0.12.0 line. Multi-user support is
specified in `llm-wiki/docs/industrialisation.md` and planned next; do not
expose the runtime as a shared write surface before that work lands.

## Release gate

`npm test` (see `package.json`) is the release gate: it includes the
orchestrator suites (registry, resolver, validator, integrator, scheduler,
attemptManager, resultAggregator, approvalPolicy), `recoveryManager.test.js`,
and `src/runtime/donna-contract.test.js`. No release ships while it is red.
When adding an orchestrator module, add its test file to the `npm test` list —
tests that exist but are not in the gate protect nothing.

## Layout

```text
wiki-workspace              Operator CLI around Docker Compose
docker-compose.yml          Shared workspace service stack
src/cli/wiki-manager.js     CLI entrypoint
src/shell/                  Repl/OpenTUI shell, panes, session state
src/agent/graph.js          LangGraph ReAct orchestrator
src/agent/llm.js            OpenAI-compatible client
src/commands/slash.js       Deterministic slash commands
src/core/agentLoop.js       Shared agent turn + multi-turn agentic loop
src/core/agentEvents.js     AgentRunEvent reducer/projection
src/core/activity.js        Generic activity normalization/polling
src/core/jobQueue.js        Workspace-scoped production queue
src/core/mcp.js             MCP endpoint discovery/session/tool calls
src/core/queueStore.js      QueueStore interface (memory & SQLite impls)
src/core/skills.js          Workspace skill discovery
src/core/workspaces.js      Workspace registry and creation
src/core/sessionConfig.js   Shared .wikirc profile application (shell + runtime)
src/orchestrator/           Generic, business-agnostic orchestration core
  agentRegistry.js          agent_describe discovery + health re-scan
  capabilityRegistry.js     capability@version → agent instances index
  capabilityResolver.js     Deterministic agent selection (no fuzzy matching)
  planValidator.js          DAG/contract/budget validation of fragments
  planIntegrator.js         Fragment integration, plan revisions, events
  scheduler.js              Ready-task computation, effective concurrency (resolvePlanConcurrency = MIN of agent/ceiling/task limits; describePlanConcurrency exposes the same number + cappedByCeiling for the UIs)
  dependencyResolver.js     Deps, groups, barriers
  lockManager.js            Task/administrative locks
  budgetManager.js          Per-run budgets (tasks, attempts, duration…)
  dispatcher.js             agent_execute/agent_status/agent_cancel driver
  assignmentManager.js      Task → agent instance assignment
  attemptManager.js         Attempts, retries, agent fallback
  resultAggregator.js       TaskResult intake, DAG update, plan expansion
  approvalPolicy.js         Bounded ApprovalGrants (run + revision + class)
src/activity/               Aggregated activity: synthesis, weighted progress, dedup
src/graph/                  Run/Task graph projection + visibility policy
src/runtime/                Agentic runtime HTTP/SSE server + SQLite store
  store.js                  SQLite persistence (events, runs, queue_items, agents, tasks, task_groups, task_dependencies, task_assignments, task_attempts, task_results, approval_grants, plan_revisions)
  server.js                 HTTP/SSE endpoints: /health /state /events/stream /run /cancel /resume /approve /control /config/profiles /config/use
  runner.js                 runRuntimeAgenticWorkflow: loop → evaluate → replan; parallel plan execution delegates to the orchestrator dispatcher (no child LLM sessions)
  recoveryManager.js        Boot-time re-attachment of active tasks via agent_status
  approvals.js              Run-level and tool-level approval gate; POST /approve handler
  supervisor.js             Background activity poller; pollBusy set shared with runner
  lifecycle.js              ensureRuntime: health-check, spawn Node child, inject token
  auth.js                   Bearer token resolution and validation
  client.js                 HTTP client for /run /cancel /resume /approve /state /events/stream
  queueStore.js             SQLite-backed QueueStore for runtime sessions
docs/                       Architecture and usage docs
```

Manager state (`.env`, `mcp.endpoints.json`, `workspaces/`, `.agents-data/`,
generated `.wiki/runtime/` compose overrides) belongs in the user-selected
manager directory, not in the installed npm package directory. On first
interactive/runtime launch, missing `.env` and `mcp.endpoints.json` are
scaffolded from the packaged examples (real paths substituted); `agents up`
generates the missing agent auth tokens.

`set_env_value` (wiki-workspace) writes generated keys onto their commented
placeholder from `.env.example` (`# OAUTH_STATE_SECRET=`, `#KEY=`, `##  KEY=`)
rather than appending a duplicate at the end of the file. An active assignment
always wins and is replaced in place; commented lines below it stay commented,
so a key never ends up assigned twice. Prose comments merely mentioning a key
are not touched.

Two user-owned Compose overrides sit under `.wiki/compose/`:
`.wiki/compose/docker-compose.override.yml` (workspace stack) and
`.wiki/compose/agents.docker-compose.override.yml` (agents stack). Both are seeded once from
the packaged `*.example.yml` templates and **never rewritten** — the opposite
policy from `.wiki/runtime/*.compose.yml`, which is generated state replaced on
every Compose command. Merge order per stack: packaged file → user override →
generated CA override (last, so a `--cacert` change always beats a stale
hand-written CA path). They are the supported place for proxy passthrough
(containers do not inherit the host environment; only `connectors` ships proxy
variables), extra mounts, and optional external agents such as the MailerSend
connector. Extending a service the packaged file does not declare creates a
phantom service — don't. See `docs/configuration.md` § "Compose overrides".

## Shell Model

Interactive ShellUI startup runs ordered infrastructure preflight checks before
workspace configuration: `docker info` first, then an HTTPS connectivity probe,
then global agents, workspace initialization/configuration, workspace
containers, MCP `tools/list`, and runtime. The network probe runs in a fresh
Node process so `NODE_USE_ENV_PROXY`, `HTTP_PROXY`/`HTTPS_PROXY`, and the active
custom CA are applied at process startup. Keep the endpoint overridable through
`WIKI_MANAGER_CONNECTIVITY_URL`. MCP checks distinguish missing configuration,
authentication, reachability, and protocol failures; when Internet is down,
remote MCPs are skipped but local endpoints are still probed. Docker failure
does not suppress host-native or remote MCP checks. The startup screen keeps
`Ready`, `Degraded`, and `Setup required` distinct and offers retry, service
start, and diagnostics without blocking entry into the shell. A runtime restart
caused by newer local source is normal maintenance output and must remain
green/informational, not an error.
After the user enters the main ShellUI and the selected workspace has loaded,
the UI runs the canonical `/status` command automatically. For **Open
workspace**, run it after starting the selected workspace services so the first
snapshot reflects their resulting state; do not duplicate status assembly in
the TUI.

- The visible agent is `donna`.
- Lines beginning with `/` execute deterministic primitives.
- Startup defaults to agentic mode; `/chat` is direct LLM chat, `/agent`
  returns to the tool-using orchestrator.
- Conversation history is scoped by workspace for the current process.
- Changing `/use` must move workspace state and conversation state together.
- Ctrl+C aborts active work when busy and exits when idle.
- OpenTUI requires Bun and a TTY. Node TTY uses the legacy `repl.js` shell;
  non-TTY uses the pipe shell in `repl.js`.
- When a runtime is available, shell agent prompts are sent to runtime `/run`,
  Ctrl+C sends `/cancel`, and `/events/stream` updates the displayed
  conversation/activity state. The legacy MCP polling interval only runs while
  no runtime stream is active.

Do not route natural-language input by keyword heuristics. The user controls
the route with `/chat`, `/agent`, and slash commands. This is about the
top-level Chat/Agent mode switch, not the `/control {action:"message"}`
classifier described under Agent Runtime below — that one *is* currently
keyword-based, by design as an interim step (see that section).

Shell UI, deterministic command output, MCP status labels, and orchestration
activity text must stay in English. The active workspace language is forwarded
to LLM prompts for generated answers only; do not localize manager UI strings
from `.wikirc`.

## Agent Orchestration

`src/agent/graph.js` is a ReAct loop:

```text
START -> orchestratorNode -> toolExecutorNode -> orchestratorNode
```

The normal path uses `streamWithTools`; fallback paths use
`completeWithTools`, `stream`, or plain content. `MAX_TOOL_ITERATIONS` caps the
loop.

Provider compatibility must follow a capability-first degradation policy.
Prefer the provider feature that best expresses the intended contract (for
example structured tool calls with a forced `tool_choice`), but never assume an
OpenAI-compatible endpoint implements every optional OpenAI behavior correctly.
Validate the actual response and, when the preferred feature is rejected,
ignored, or returns an unusable shape, retry through the closest semantically
equivalent lower-capability path (for example tool call → JSON text completion
→ validated plain content). Only report failure after the compatible fallbacks
are exhausted. A provider-compatibility error must never be silently converted
into a business result such as "not an action", "no task", or "unsupported
operation". Keep this ordering generic and provider-driven; do not add model,
agent, capability, or business-verb branches to compensate for one endpoint.

Tests for a preferred provider feature must also cover its degraded path. In
particular, any use of forced `tool_choice` needs coverage for an endpoint that
throws and for one that ignores the choice and returns no `tool_calls`.

Internal tools:

- `shell__run_command`: safe manager slash commands only.
- `wiki__plan_set`: set plan projection.
- `wiki__plan_done`: update one plan step.

Remote llm-wiki MCP tools remain namespaced as `wiki__wiki_list_pages`,
`wiki__wiki_read_page`, etc. Do not route the whole `wiki__*` namespace to
internal handlers.

`callMcpTool` auto-injects `configPath` into `production_start_job` when absent
from args and available from the active `.wikirc` profile. It also surfaces MCP
errors as `Error [<server>.<tool>]: <message>`.

## Skills And Donna Help

Workspace skills come from the active workspace manifest and `.wiki/skills/`.
They are **executable**: `/skills run <name>` and `/<name>` both post the
invocation to the runtime, which compiles the body and starts the resulting
runs. Nothing injects a skill body into a local prompt any more — the only
exception is `wiki-manager --headless --no-runtime`, kept for the legacy
direct-MCP path.

`core/skillCompiler.js` turns a body into 1..12 **business intentions**. The
split is deterministic — numbered lists, bullets, or a paragraph opening on a
strong connector (`Puis`, `Then`, `Ensuite`, `if available`…) — and the LLM is
only consulted when the deterministic pass finds the text ambiguous, bounded by
an 8s timeout with a JSON-text retry, degrading to a single intention. This
means **the markdown shape of a skill body decides how many runs it produces**:
rewriting "Then ingest…" as "After the export, ingest…" silently collapses two
runs into one. `pipeline` must stay a single objective — fragmenting it would
strip the production capability of its own DAG and concurrency.

One objective becomes one control item, one run, one `resolveObjective` call.
Items of the same skill share a `chainId` and a `chainSequence`; a step runs
only once every predecessor is terminal, and a required predecessor that fails
or is cancelled marks the rest `skipped` with a `skipReason`. Skill items never
carry a `capabilityPlan` — a structured enqueue still does, untouched.

Parameters are appended as a `User parameters:` block to **every** objective of
the chain, after validation. Not before the split: `/wiki-sync ESPACE` would
otherwise hand `source` to the ingest step and leave the export step, the one
that consumes it, exporting everything. Legacy `{param}` placeholders are still
substituted when a body contains them.

`RESERVED_SLASH_COMMANDS` (`core/skillInvocation.js`) lists the names where a
built-in wins: `/status` stays the built-in status command, and the scaffold
skill of the same name is reachable only through `/skills run status`, which
carries `skillName` and sets `allowReserved`. The browser keeps its own copy of
that list in `llm-wiki/src/chat/chatHtml.ts` — keep them identical.

`/run cancel` is chain-scoped: it stops the current run and skips the rest of
*that* chain, leaving unrelated queued items alone, and does nothing to the
chain when the cancelled step was `optional`. `/run kill` stays workspace-wide
and purges everything. `/queue cancel <id>` targets one runtime item and only
propagates to later steps of its own chain.

The chain is a **projection**, never stored state: `core/skillChainView.js`
derives it from the control queue and publishes it as `skillChains` on the
agent projection, which both the Shell queue panel and the serve Activity panel
render.

For onboarding/discovery questions ("what is this app", chat vs agent mode,
getting started, troubleshooting), Donna answers from the `help_list`/
`help_read` tools exposed by the `wiki` MCP server — bundled, workspace-
independent product documentation (`llm-wiki/help-doc/`), not a skill. It is
also browsable in `wiki serve`'s chat Help panel and at `/help`. There is no
`guide` scaffold skill or auto-starting onboarding workflow (removed); do not
reintroduce one for this purpose. For an actual connector/credential setup
task, use read-only status/list tools first, then ask only for the settings
required by whatever connector is actually present, and call the matching
setup tool once confirmed. `/status` remains a concise state check.

## Safe LLM Actions

The LLM may use connected MCP tools and the restricted `shell__run_command`
tool. For actionable requests, do not answer with future intent only: call the
tool in the same turn when arguments are known. If arguments are missing, ask
for exact values. If the tool/server is unavailable, name the blocker.

Connector setup/configuration is usually synchronous and workspace-scoped. Call
the matching setup tool directly when it is connected and required settings are
known. Activity resumes only long-running jobs returning `_activity`, such as
imports, exports, conversions, or production jobs.

Safe `shell__run_command` commands:

```text
/workspaces
/workspace init <name> [path]
/use <workspace>
/config ...
/status
/services
/skills
/skills show <name>
/skills run <name>
```

Do not expose `/mcp call`, `/wiki run`, `/start`, `/stop`, `/logs`, `/exit`, or
raw system commands through this tool without a separate allowlist design.

## Agent Runtime

`wiki-manager runtime` starts a persistent HTTP/SSE server (default
`127.0.0.1:7788`) that shares orchestration state between the Shell UI and
`llm-wiki serve`. The Shell sends agent runs to the runtime; serve proxies the
same runs from the web. `--host 0.0.0.0` is an explicit exposed-host mode and
requires bearer-token protection.

The multi-turn orchestration loop is shared in `src/core/agentLoop.js`.
Headless and runtime provide different callbacks for logging/events and
different activity waiters, but both use the same turn → plan fallback →
activity wait → continuation prompt flow.

Key modules in `src/runtime/`:

- **`store.js`**: SQLite persistence via `node:sqlite` `DatabaseSync`. Tables:
  `events` (sequence AUTOINCREMENT primary key, replayed ORDER BY sequence),
  `runs`, `queue_items`. `events.task_id` (0.10.3, migrated in via
  `ensureColumn` like `sequence`/`workspace` before it) persists the same
  `taskId` already carried by `AgentRunEvent` (populated for parallel-scheduler
  child tasks via `_currentRunIdentity`, see runner.js). `hydrateSession`
  replays on startup. `runtime_log` events are never persisted (unbounded —
  SSE-only). `RUN_STATUS_BY_EVENT` maps all run-affecting event types to their
  run status (including `run_pending_approval` and `run_approved`).
  `listAuditTrail({workspace, runId})` (0.10.3) reshapes `listEvents` into a
  correlated audit view (`sequence, runId, turnId, taskId, activityId,
  toolCallId, workspace, caller, status, tool, summary`) — derived from the
  same persisted events, not a second storage mechanism.
- **`server.js`**: `GET /health`, `GET /state`, `GET /events/stream` (SSE),
  `GET /audit` (0.10.3, `listAuditTrail`, filterable by `workspace`/`runId`),
  `POST /run`, `POST /turn`, `POST /cancel`, `POST /kill`, `POST /resume`,
  `POST /approve`, `POST /conversation/truncate`, `GET`/`POST /control`,
  `GET /config/profiles`, and `POST /config/use`. `running` flag
  is set before `await readJson` to close the TOCTOU race on concurrent
  `POST /run` requests. `resolveBodyContext(request, url)` centralizes the
  read-body → resolve-workspace → resolve-context sequence shared by the
  POST handlers that carry a JSON body. `/run` and every `/control` action
  validate their body against `contracts/schemas.js`'s `runRequest`/
  `controlMessage` (see Contracts below).
- **`runner.js`**: `runRuntimeAgenticWorkflow` — the full runtime run sequence:
  agentic loop → optional evaluator (`evaluateRuntimeRun`) → optional replanner
  (`replanRuntimeRun`) if evaluation fails or a tracked activity ends in error,
  with a configurable `maxReplans` limit. Each replan emits `run_replanned` and
  restarts the loop on the partial plan. `finishRuntimeRun` provides the same
  evaluate-and-finish tail for legacy/external callers. Takes `pollBusy` from
  the supervisor to prevent double-polling.
  `runner.e2e.test.js` (plan 0.11.4 §3 exit criterion) runs the same
  `runRuntimeParallelPlan` code path against a 2-task plan with a fixed
  simulated per-task latency, once at `concurrency: 1` and once at
  `concurrency: 2`, and asserts the parallel run finishes under 65% of the
  sequential run's wall time — a CI guard against the scheduler itself
  regressing, not proof that a real llm-wiki build/provider round-trip shows
  the same margin. `donna-contract.test.js` (see Release recipe gate above)
  drives this same code path with a mocked per-turn agent for rows 1-3 and 8,
  and the real `/control` HTTP endpoint for row 7.
- **`approvals.js`**: run-level and tool-level approval gate. Run-level:
  `requireApproval: true` in the `/run` body suspends execution after the first
  plan is formed and emits `run_pending_approval`; `POST /approve?runId=...`
  unblocks. Tool-level: tools listed in endpoint `requireApproval` or
  `WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS` emit `tool_pending_approval` and queue
  the item as `pending_approval`; `POST /approve?itemId=...` or shell
  `/approve item <id>` unblocks. Timeout defaults to 10 min
  (`WIKI_MANAGER_APPROVAL_TIMEOUT_MS`, or `approvalTimeoutMs` per run).
  Directly-launched capability runs (ingest/pipeline via `preparedDelegation`)
  now **wait by default**: the scheduler emits a per-task `approval.requested`
  for each mutating task and blocks on `approvalCovered()` until a run-scope
  grant arrives (`/approve` / the Approve button). Auto-approval
  fires only when the caller passes `autoApprove: true` (headless/CI). A granted
  run/group scope also flips its covered `pending_approval` grants to `approved`
  in the store and cascades on run purge (no orphan grants). Pending approvals
  are surfaced in both UIs: Shell right-pane amber banner + plan step `[⏸]`,
  and `serve` banner above the composer (`POST /api/runtime/approve`).
- **`supervisor.js`**: polls non-terminal `_activity` items on an interval.
  Exposes `pollBusy` set shared with the runner.
- **`lifecycle.js`**: `ensureRuntime` — resolves token, health-checks an existing
  runtime, spawns a child Node 22 process if absent, injects token into both
  parent and child env. When the shell runs under Bun, uses
  `WIKI_MANAGER_NODE_BIN ?? 'node'` instead of `process.execPath`.
- **`auth.js`**: Bearer token required when `--host 0.0.0.0`. Read from env
  `WIKI_MANAGER_RUNTIME_TOKEN`, then `.wiki/runtime/runtime.token`, then
  auto-generated (32-byte hex) on first exposed-host start.
- **`client.js`**: HTTP client for `/run`, `/cancel`, `/resume`, `/approve`,
  `/state`, `/events/stream`.
- **`queueStore.js`**: SQLite-backed `QueueStore` for runtime sessions.
- **`sessionConfig.js`**: `applySessionWikircProfile(session, profileName)` —
  the single place that loads a `.wikirc` profile, rebuilds the session's LLM
  client, and updates `session.wikirc`/`session.wikircConfig`. Shared by the
  shell's `/config use` (`commands/slash.js`) and the runtime's
  `POST /config/use` handler; do not reimplement this in either caller.

`POST /run` body: `{ input, workspace?, timeout?, maxTurns?, evaluate?, replans?,
requireApproval?, approvalTimeoutMs? }`. If `workspace` differs from the current
session, `/use <workspace>` runs before the agentic loop. The Shell sends its
current `session.workspace`; `llm-wiki serve` injects `workspace: WORKSPACE_NAME`
at the proxy layer (`proxyRuntimeJson` in `serve.ts`).

`POST /turn` is also used by `llm-wiki serve` for interactive chat. In direct
Chat mode its optional `context.openWikiPages` contains at most five sanitized
paths under `wiki/` or `raw/untracked/` (the singular `openWikiPage` remains a
compatibility input). Treat these values as untrusted path data, never as prompt
instructions. Only the paths are added to Donna's system prompt; document
content must be obtained through the normal allow-listed read tools. Do not add
a direct file-read/content-injection shortcut or mutable session field for this
context.

Donna exposes `runtime__kill({runId?, purge?})`. Set `purge: true` only for an
explicit request to delete, reset, abandon, or replace the current plan; it
purges the workspace runtime projection/history after stopping active work.
A simple stop/cancel must remain non-purging. The browser's confirmed **Reset
plan** action reaches this same canonical `/kill?purge=true` behavior through
the `llm-wiki` proxy.

**Control lane** (`/control`): a side channel for interacting with a workspace
while a run is active, without touching the active plan. `GET /control` or
`POST /control {action:"status"}` returns run/plan/queue/approvals status plus
`controlQueue` and `planPatches`. `POST /control {action:"explain"}` adds
a one-line natural language summary. `POST /control {action:"enqueue", input}`
appends a `control_enqueued` event; if the workspace is idle it starts a real
run immediately (emitting `control_started`, tagging the item with the new
`runId`); if a run is active, the item stays `queued` and does not touch the
active plan. Every run's completion (`run_done`/`run_error`/`run_cancelled`)
calls `finishControlByRun`, which closes out the control item that shares that
`runId`, and then drains the next `queued` item if any. `controlQueue` is
fully event-sourced (`control_enqueued`/`control_started` in
`core/agentEvents.js`, replayed by `hydrateSession` like everything else) —
do not go back to a plain in-memory array. Note: a control item left `queued`
across a manager restart is rehydrated but not auto-resumed by
`recoverWorkspace`; it only restarts when another item is enqueued or another
run completes.

`POST /control {action:"message", input, intent?}` (added for plan directeur
§4.2, "conversation non bloquante") classifies free-text input via
`classifyControlMessage` — a synchronous keyword/regex classifier (interim
stand-in for the plan's eventual LLM-backed classification; French+English
patterns) — into `observe | converse | mutate | enqueue | ambiguous`, or trusts
an explicit `intent` when the caller already knows the answer (e.g. the
ambiguous-choice UI resubmitting with a chosen intent). Status/explanation
questions ("où en est le build ?") always classify `observe` and never create a
run. `enqueue` behaves like the existing `action:"enqueue"` path above.
`ambiguous` returns `choices` (`observe`/`mutate`/`enqueue`) instead of
guessing — required by the plan's fallback-UX rule. ShellTUI (`repl.js`)
routes a busy-runtime prompt through `action:"message"` instead of
unconditionally enqueueing; `llm-wiki`'s Agent mode chat does the same via
`/api/runtime/control` (see `llm-wiki/CLAUDE.md`).

`mutate` (0.10.0) is now a real, event-sourced plan-patch proposal, not a
dead-end note: `storeControlProposal` builds a patch via
`buildPlanPatchFromInput` (`src/core/planPatch.js`) and dispatches
`control_message_received` + `plan_patch_proposed`; `POST /control
{action:"approve_patch", patchId}` dispatches `plan_patch_approved` +
`plan_patch_applied` (rebasing first via `plan_patch_rebased` if
`state.planRevision` moved since the proposal's `basePlanRevision`).
`state.planPatches`/`state.planRevision` are reducer-owned
(`src/core/agentEvents.js`) and persisted like every other event
(`NON_PERSISTED_EVENT_TYPES` only excludes `runtime_log`) — this is the fix for
the gap noted above through 0.9.5. The old plain-array `controlProposals`
(session field, non-persisted, response field, `approvePlanPatch` fallback
lookup) has been removed — `planPatches` is the only mechanism now. Do not
reintroduce a second, session-local proposal list; extend `planPatches`
instead.

`applyPlanPatch`/`rebasePlanPatch`/`readyPlanTasks`/`nextReadyPlanTask`
(`src/core/planPatch.js`, pure, no I/O) implement the 6 patch ops from plan
§7.2 (`add_task`, `add_dependency`, `remove_dependency`, `cancel_task`,
`replace_executor`, `request_approval`) with dependency-cycle rejection, and
the "ready = pending + all `dependsOn` done" rule from §7.4.
`src/core/agentLoop.js` uses `nextReadyPlanTask`/`readyPlanTasks` to prompt the
LLM with exactly one ready task per turn ("Start exactly this next ready task
only. Do not start tasks whose dependencies are not done.") — this is
LLM-cooperative sequencing via the prompt, not code-enforced; hard enforcement
(rejecting tool calls for non-ready tasks) is not built yet and may be needed
for 0.10.1's real parallelism. A legacy plan with no `dependsOn` still executes
in step order: every pending step is vacuously "ready" (empty `dependsOn`
array), and `nextReadyPlanTask` always returns the lowest `step` number among
them, so behavior is unchanged from before 0.10.0. `runner.js`'s
`mergeReplanWithCompleted` keeps `done` steps (with their `outputRefs`) ahead
of newly replanned steps, which all depend on them.

**Config profile switching** (`/config/profiles`, `/config/use`): lists and
switches the active `.wikirc` profile for a workspace via
`applySessionWikircProfile`. `POST /config/use` is rejected with 409 while a
run is active. `llm-wiki serve` treats the manager as the canonical source for
which profile is active — see `llm-wiki/CLAUDE.md`'s Agent Runtime Integration
section for how serve re-derives its own config instead of trusting the raw
payload.

**UI-managed MCP endpoints** (`src/core/mcpEndpoints.js`, runtime route
`GET|POST /mcp/endpoints`): the served Connectors panel writes
`mcp.endpoints.json` through the runtime. Invariants, all enforced there rather
than in the caller:

- `PROTECTED_SERVERS` (`wiki`, `production`, `llm-wiki`, `wiki-production`)
  cannot be upserted or deleted — they are workspace stack, not connectors.
- An upsert writes `chatAccess.servers[name] = { allow: '*' }`. A server absent
  from `chatAccess` gets **zero** tools in `/chat` (`chatAllowedTools`), so
  skipping this would make a freshly added connector work in `/agent` and
  silently do nothing in `/chat`.
- A delete pushes the name into `disabledMcpServers`, which
  `ensureManagerScaffold`'s additive merge honours — otherwise the next
  `agents up` would restore from the packaged example a connector the user
  removed on purpose.
- Rename goes through `previousName` and is atomic: endpoint, headers and
  `chatAccess` entry move together, a missing source or an occupied target is
  refused rather than half-applied. Deletion identity is the persisted name,
  never the displayed one.
- `POST` is **409 while a run is active** (`listActiveRuns`), like
  `POST /config/use`: connector wiring must not change under a run that already
  resolved its agents. Callers must not read that as a broken connector —
  `llm-wiki`'s panel keeps the card connected and retries later.

**Workspace profile injection.** `.wiki/profile.md` is loaded from disk into the
system prompt of **both** shell modes through the single loader
`loadWorkspaceProfile` (`src/core/profile.js`), used by `buildAgentSystemPrompt`
and `buildDirectChatSystemPrompt`; `llm-wiki serve` does the same in its own chat
route. Do not replace this with a `profile_read` entry in `chatAccess`: the
additive scaffold merge only fills **missing top-level keys**, so a new tool
inside an existing allow-list never reaches an install that already has an
`mcp.endpoints.json` — and durable preferences must shape every reply, not only
the turns where the model thinks to fetch them. The loader returns `null` for a
missing, empty or unreadable profile and never throws; a missing profile must
degrade the reply, not break it. `profile_update` stays out of chat: it mutates.

After any write, `refreshAllMcpContexts()` (wiki-manager.js) replays
`refreshMcpRuntimeStatus` + `discoverAgentsOnce` on every live context.
`buildMcpStatus` re-reads the file each time, so chat tools, agent tools and
plan capabilities all pick the change up without a restart.
`agentRegistry.discover` unregisters agents whose server has disappeared,
emitting `agent.unregistered` — a deleted connector must not stay resolvable as
a capability.

MCP `tools/call` retries transient HTTP/MCP failures. Configure globally with
`WIKI_MANAGER_MCP_RETRY_MAX_ATTEMPTS` and `WIKI_MANAGER_MCP_RETRY_BACKOFF_MS`,
or per endpoint (`retry`) and per tool (`toolRetries`) in `mcp.endpoints.json`.
The env-based defaults are resolved once and cached in `getEnvRetryPolicy()`.

**QueueStore** (`src/core/queueStore.js`): interface with `list()`, `replace()`,
`changed()`. `createMemoryQueueStore` for shell/headless sessions;
`createSqliteQueueStore` for runtime sessions. `jobQueue.js` routes through
`queueStoreFor(session)` transparently.

## Contracts

`src/contracts/schemas.js` (0.10.3): versioned (`v1`) JSON-schema-like
contracts for `_activity`, `AgentRunEvent`, `plan`, `planPatch`, `runRequest`,
`controlMessage`, `outputReference` — a small hand-rolled validator, not a
JSON Schema library, since this repo stays plain JavaScript (plan §10.1). All
schemas tolerate additional properties so an older or newer agent can extend
payloads without breaking. `validateContractInDev(name, value)` only
validates when `WIKI_MANAGER_VALIDATE_CONTRACTS=1`, `CI=true`, or `NODE_ENV`
is a non-production value — off in production so a malformed-but-tolerated
extra field from an older agent doesn't hard-fail a real run. Wired in at
`core/activity.js` (`normalizeActivity`), `core/agentEvents.js`
(`createAgentEvent`/`dispatchAgentEvent`/`normalizePlan`), `core/planPatch.js`
(`normalizePlanPatch`), and `runtime/server.js` (`/run`, every `/control`
action). Extend `contractSchemas` here rather than validating ad hoc
elsewhere.

## Activity, Plan, Queue

All plan/activity mutations go through `dispatchAgentEvent` and the reducer in
`src/core/agentEvents.js`.

- `run_started` clears stale plan/activity state; `state.plan` starts `null`
  (0.9.6 — no fictional plan is injected; a run without a tool call or a
  `wiki__plan_set`/`_activity.plan.steps` completes without a fake plan
  driving it).
- `run_done` finalizes all running/pending plan steps to `done`.
- `run_evaluated` sets `state.evaluation { ok, reason, suggestedAction }`.
- `run_replanned` records `state.replans[]` entries and resets the plan.
- `run_pending_approval` sets run status to `pending_approval` in SQLite.
- `run_approved` restores run status to `running` in SQLite.
- `tool_pending_approval` / `tool_approved` track tool-level approval lifecycle.
- `plan_set` replaces the current plan. Steps accept the legacy string form or
  the structured `{id, description, dependsOn, executor, outputRefs}` form
  (`wiki__plan_set` in `src/agent/graph.js`); `executor` is picked dynamically
  from `tools/list` by `selectExecutorForStep` when the LLM omits it — never
  hardcoded per server.
- `activity_upserted` syncs activity and may create/replace the plan;
  `dependsOn`/`executor`/`outputRefs` on `_activity.plan.steps` are preserved
  through `ensurePlanFromActivityProjection`.
- `plan_step_updated` patches one step.
- The free-text plan extraction fallback (`onPlanExtracted` /
  `startRuntimeAgenticWorkflow` text parsing) is marked `deprecated fallback`
  in its own log line; prefer structured `wiki__plan_set` or `_activity`.

**`projectWorkflow(state, events)`** (`src/core/workflow.js`, 0.9.6): the
canonical read model consumed by both Serve (`chatHtml.ts`'s
`runtimeTaskPanelHTML`) and ShellTUI (`useSession.ts`/`repl.js`) — do not add
a second UI-side projection. Outputs `nodes` (`run`, `task`, `activity`,
`queue`, `approval`, `executor`, `output`, `replan` types), `relations`
(`contains`, `depends_on`, `executed_by`, `produces`, `approves`, `replaces`),
`current`, `next`, `progress`, `waitingReasons`, `warnings`. Decision (recorded
in the module itself): `projectWorkflow` *consumes* the existing event-sourced
`agentProjection`/reducer rather than replacing it — `agentProjection` stays
the compatibility hydration format, `workflow` is the canonical UI read model.
An old run with a flat plan (no `dependsOn`) still projects as a readable
sequential chain. `applyAgentProjectionToSession` stores the result on
`session.workflow`; `runtime/store.js`'s `getState()` exposes it queue-aware in
`/state` as `workflow`.

`/state` exposes: `status`, `plan`, `activities`, `conversation`, `evaluation`,
`replans`, `approvals`, `runs`, `queue`, `workflow`, `eventsCursor`,
`concurrency`.

`projectWorkflow` also emits `usage` (token totals + `byTask`) and
`timingByTask` (`{ startedAt, finishedAt, durationMs }` per task, derived from
`task.started`/`assigned`/`completed`/`failed` events) — display-only, used by
the serve run-graph inspector to show the per-task flow (ordered by start) with
duration and tokens in/out. `getState()` additionally surfaces the live run's
resolved scheduler concurrency as `state.concurrency = { limit, ceiling,
agentLimit, cappedByCeiling }` (from `session._runConcurrency`, set once by the
runner). Both the Shell and serve run summaries read it for the authoritative
"max ×N" and the amber "(ceiling)" marker; never consumed by scheduling.

Any MCP can opt into manager monitoring by returning additive `_activity`
metadata with `id`, `source`, `kind`, `label`, `status`, optional `progress`,
optional `poll`, timestamps, `error`, and `terminal`.

`src/core/jobQueue.js` queues `production_start_job` only when the workspace is
already busy locally or the MCP server returns `workspace_busy`. MCP locks
remain the source of truth. Queue state is workspace-scoped.

## Workspace Rules

- Workspaces are registered under `./workspaces/` unless `WIKI_WORKSPACES_DIR`
  overrides it.
- `workspaces/`, `.agents-data/`, generated `.env`, exports, raw content, and
  symlink targets must stay uncommitted.
- The manager must not contain a root `SKILL.md` or root `skills/` directory.
- Workspace skill packages follow the fixed workspace layout: `CLAUDE.md`,
  `templates/`, `build-context/`, `.wiki/system-prompt.md`, `.wiki/skills/`.
- Workspace names must be path-safe: alphanumeric at both ends, only
  letters/digits/underscore/dot/dash inside, no `..`.
- LLM/vector provider config belongs in each workspace `.wikirc.yaml`.

## Docker And Security

- Workspace Docker Compose runs `serve`, `mcp-http`, and `production-mcp` per
  workspace. It intentionally does not start `agent-runtime`, because the
  runtime is global and binds a single port.
- `agent-runtime` runs on the host through `wiki-workspace runtime up` or
  `ensureRuntime` from the shell. It requires Node.js 22+ for `node:sqlite`.
  When the shell runs under Bun, lifecycle code starts the runtime with
  `WIKI_MANAGER_NODE_BIN` or `node`, never Bun.
- The host runtime listens on `0.0.0.0:7788` by default — every start path
  (`wiki-workspace runtime up`, `ensureRuntime`, `wiki-manager runtime`) agrees,
  and `.env.example` ships `WIKI_MANAGER_RUNTIME_HOST=0.0.0.0` active. A
  loopback bind is invisible to `serve`, which runs in Docker and connects
  through `host.docker.internal`. Exposing the port always resolves an auth
  token (`resolveRuntimeAuthToken` generates `.wiki/runtime/runtime.token`,
  mode 0600), so it is never an unauthenticated bind. Set
  `WIKI_MANAGER_RUNTIME_HOST=127.0.0.1` to opt out when nothing runs in a
  container; `ensureManagerScaffold` never overwrites that choice. State lives
  under `.wiki/runtime/`.
- `serve` receives `WIKI_MANAGER_RUNTIME_URL=http://host.docker.internal:7788`
  and `WIKI_MANAGER_RUNTIME_TOKEN` to connect to the runtime.
- Prefer `wiki-workspace` over raw `docker compose`.
- Keep `package.json`, MCP `clientInfo.version`, and external agent
  `_AGENT_VERSION` values aligned for each coordinated release. The release
  line is whatever `package.json` declares — do not restate it here, it drifts.
  `scripts/check-versions.js` verifies this (wired to `prepack`
  and `prepublishOnly`; `CHECK_GIT_TAG=1` and `CHECK_DOCKER_IMAGES=1` add
  optional pre-release gates). The root `build-and-push.sh` (outside this
  package) syncs versions across all six service repos before building.
- `--cacert <path>` is the supported way to trust a local proxy/private CA for
  the manager process and Docker Compose services. The file path must exist on
  the host and be readable by Docker; the certificate is mounted directly from
  that path, not copied into manager state.
- When `--cacert` is present, generated overrides live under the manager state
  directory: `.wiki/runtime/cacert.compose.yml` for workspace services and
  `.wiki/runtime/agents.cacert.compose.yml` for global agents. They are
  generated state and are refreshed whenever the active `--cacert` path or
  Compose services change. Do not edit them manually: the next Compose command
  overwrites stale content from the current certificate path and services.
- CA overrides inject `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE` in containers; do not hard-code
  equivalent machine-specific certificate settings in the base compose files.
- Keep default production pipeline as `ingest`, `build`, `export`, `polish`.
- Use `stabilize: true` for production builds that should preserve unchanged
  existing deliverable sections.
- The legacy `copy` step is only for deployments that explicitly configure it.
- Keep machine-specific settings out of `docker-compose.yml`; use ignored local
  overrides.
- MCP tokens must not be logged, printed, or serialized in session dumps.
- Clipboard handling should use `execFileSync` with argv arrays.

## Workspace reset

`wiki-workspace wiki <workspace> reset` (`reset_workspace` in the `wiki-workspace`
script) empties a workspace and keeps the method: `.wikirc*`, `templates/`,
`build-context/`, `.git/` when present — and `.env`. The keep list lives in one
place, `workspace_reset_keep`; everything else under the workspace root is
removed, then `wiki init` restores the empty structure (it never overwrites an
existing file, which is what makes the kept entries survive).

`.env` is on that list for a stronger reason than method. It carries the
workspace's registration — ports, MCP auth tokens, `WIKI_WORKSPACE_PATH` — and
`run_wiki` opens with `need_workspace_env`. Dropping it from the keep list makes
the `wiki init` line of `reset_workspace` `die` under `set -euo pipefail`, right
after the deletion loop: the workspace ends up erased *and* never re-scaffolded.
Recovering with `wiki-workspace config` then mints new ports and tokens,
invalidating whatever referenced the old ones (`mcp.endpoints.json` first).

Invariants, in order of importance:

- **It exists only in this CLI.** No `wiki reset` subcommand in llm-wiki, no
  `reset` job type in the production agent's step allowlist, no MCP tool, no
  scaffold skill. Nothing Donna can call may erase a workspace, and adding an
  agent-reachable path to it would undo that.
- **It never chains.** No sync, no build, no ingest afterwards. Erasing and
  refilling are two decisions, and only the first one was asked for.
- **It refuses while services run** (`ps --status running --services`): a
  container writing into the bind mount recreates part of what was erased and
  leaves files owned by another UID.
- The scaffold's `raw/untracked/demo-project-brief.md` is deleted after the
  re-init. Reappearing in an existing project it would not read as a sample but
  as a pending source, and the next ingest would file it into the wiki.

## Commands And Validation

Common commands:

```bash
wiki-workspace config <workspace> [path]
wiki-workspace up <workspace>
wiki-workspace wiki <workspace> doctor
wiki-workspace wiki <workspace> reset [--dry-run] [--yes]
wiki-workspace agents status
wiki-workspace --cacert /absolute/path/to/ca.pem up <workspace>
wiki-workspace --cacert /absolute/path/to/ca.pem agents up
bun start
pnpm run start:node
node ./bin/wiki-manager.js --cacert /absolute/path/to/ca.pem --headless --workspace <name> --prompt "check status"
```

Before committing manager changes:

```bash
pnpm run check
```

Also exercise relevant paths:

```bash
printf '/use <workspace>\n/config status\n/workspaces\n/exit\n' | node ./bin/wiki-manager.js
node ./bin/wiki-manager.js --headless --workspace __missing__ --prompt test
wiki-manager --headless --workspace <workspace> --skill pipeline --timeout 3600 --max-turns 20
wiki-manager --headless --workspace <workspace> --skill "deliver rapport polish" --auto-approve
wiki-workspace runtime up
wiki-workspace runtime status
wiki-manager runtime [--host 127.0.0.1] [--port 7788] [--state-dir .wiki/runtime]
# approve a pending run or tool approval from the shell:
/approve run <runId>
/approve item <itemId>
```

Headless `--skill` goes through the **same runtime resolver** as the Shell and
serve, so a multi-capability skill produces the same chain everywhere. Its value
carries the arguments inline (`--skill "deliver rapport polish"`); `--prompt` is
ignored on that path and says so. The wait is chain-scoped, not run-scoped —
`waitForRuntimeChain` follows every step of the `chainId` and exits non-zero if
any of them failed, so `wiki-sync` cannot report success when only the export
finished. A chain blocked on approval returns immediately with an explicit
message unless `--auto-approve` is passed, which grants one run-scoped approval
per plan revision. `--no-runtime` keeps the legacy agentic loop: run a turn,
wait for active MCP activities, then re-invoke until the skill is done or limits
are reached.

`wiki-manager runtime` starts the HTTP/SSE runtime server. When launched by
`ensureRuntime` (shell path), the token is resolved before spawning and injected
via `WIKI_MANAGER_RUNTIME_TOKEN`. `wiki-workspace runtime up` writes/reuses
`WIKI_MANAGER_RUNTIME_TOKEN` in the manager `.env` so Dockerized `serve` can
call the host runtime through `host.docker.internal:7788`.
