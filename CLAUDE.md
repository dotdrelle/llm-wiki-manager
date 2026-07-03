# Repository Guide

## Purpose

`llm-wiki-manager` orchestrates multiple `llm-wiki` workspaces. It owns
workspace registration, Docker Compose wiring, MCP endpoint coordination, and
the `donna` agent shell.

Keep it a manager. Do not absorb responsibilities from `llm-wiki`,
`agent-cme`, `agent-wiki-production`, or other external agents.

The multi-repo roadmap driving current work lives in `plan-directeur-revise.md`
at the wikiLLM workspace root (one level above this repo, not versioned here).
It sequences 0.9.3 → 0.11.0 across all six service repos; sections referenced
below (e.g. "plan §4.2") point into that document. As of this writing, 0.9.3
and 0.9.4 (`serve.ts`/`chatHtml.ts` module extraction, this repo untouched by
that lot) are released; 0.9.5 (single orchestrator, non-blocking control-lane
conversation — see Agent Runtime below) is in progress.

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
src/runtime/                Agentic runtime HTTP/SSE server + SQLite store
  store.js                  SQLite persistence (events, runs, queue_items)
  server.js                 HTTP/SSE endpoints: /health /state /events/stream /run /cancel /resume /approve /control /config/profiles /config/use
  runner.js                 runRuntimeAgenticWorkflow: loop → evaluate → replan; finishRuntimeRun; evaluateRuntimeRun; replanRuntimeRun
  approvals.js              Run-level and tool-level approval gate; POST /approve handler
  supervisor.js             Background activity poller; pollBusy set shared with runner
  lifecycle.js              ensureRuntime: health-check, spawn Node child, inject token
  auth.js                   Bearer token resolution and validation
  client.js                 HTTP client for /run /cancel /resume /approve /state /events/stream
  queueStore.js             SQLite-backed QueueStore for runtime sessions
docs/                       Architecture and usage docs
```

Manager state (`.env`, `mcp.endpoints.json`, `workspaces/`, `.agents-data/`,
generated `.wiki-manager/` compose overrides) belongs in the user-selected
manager directory, not in the installed npm package directory.

## Shell Model

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

## Skills And Donna Guide

Workspace skills come from the active workspace manifest and `.wiki/skills/`.
`/skills run <name>` injects the skill body into the agent as workflow
instructions.

The scaffold-level `guide` skill is Donna's onboarding/discovery workflow. It
should check LLM setup, MCP reachability, connected source/document/delivery
capabilities, wiki content, and generation actions. It should use read-only
status/list tools first, then ask only for the settings required by whatever
connector is actually present. Do not move connector credential setup into a
separate manual settings flow when the connected setup tool can perform it.

`/status` remains a concise check. `/guide` is the interactive first-run path.
In `wiki serve`, first visit may auto-start `/guide` only once per workspace;
the empty chat and Activity panel also expose manual `Start setup guide` tiles.

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

`wiki-manager runtime` starts a persistent HTTP/SSE server (default port 7788)
that shares orchestration state between the Shell UI and `llm-wiki serve`. The
Shell sends agent runs to the runtime; serve proxies the same runs from the web.

The multi-turn orchestration loop is shared in `src/core/agentLoop.js`.
Headless and runtime provide different callbacks for logging/events and
different activity waiters, but both use the same turn → plan fallback →
activity wait → continuation prompt flow.

Key modules in `src/runtime/`:

- **`store.js`**: SQLite persistence via `node:sqlite` `DatabaseSync`. Tables:
  `events` (sequence AUTOINCREMENT primary key, replayed ORDER BY sequence),
  `runs`, `queue_items`. `hydrateSession` replays on startup. `runtime_log`
  events are never persisted (unbounded — SSE-only). `RUN_STATUS_BY_EVENT`
  maps all run-affecting event types to their run status (including
  `run_pending_approval` and `run_approved`).
- **`server.js`**: `GET /health`, `GET /state`, `GET /events/stream` (SSE),
  `POST /run`, `POST /cancel`, `POST /resume`, `POST /approve`, `GET`/`POST
  /control`, `GET /config/profiles`, `POST /config/use`. `running` flag
  is set before `await readJson` to close the TOCTOU race on concurrent
  `POST /run` requests. `resolveBodyContext(request, url)` centralizes the
  read-body → resolve-workspace → resolve-context sequence shared by the
  POST handlers that carry a JSON body.
- **`runner.js`**: `runRuntimeAgenticWorkflow` — the full runtime run sequence:
  agentic loop → optional evaluator (`evaluateRuntimeRun`) → optional replanner
  (`replanRuntimeRun`) if evaluation fails or a tracked activity ends in error,
  with a configurable `maxReplans` limit. Each replan emits `run_replanned` and
  restarts the loop on the partial plan. `finishRuntimeRun` provides the same
  evaluate-and-finish tail for legacy/external callers. Takes `pollBusy` from
  the supervisor to prevent double-polling.
- **`approvals.js`**: run-level and tool-level approval gate. Run-level:
  `requireApproval: true` in the `/run` body suspends execution after the first
  plan is formed and emits `run_pending_approval`; `POST /approve?runId=...`
  unblocks. Tool-level: tools listed in endpoint `requireApproval` or
  `WIKI_MANAGER_REQUIRE_APPROVAL_TOOLS` emit `tool_pending_approval` and queue
  the item as `pending_approval`; `POST /approve?itemId=...` or shell
  `/approve item <id>` unblocks. Timeout defaults to 10 min
  (`WIKI_MANAGER_APPROVAL_TIMEOUT_MS`, or `approvalTimeoutMs` per run).
- **`supervisor.js`**: polls non-terminal `_activity` items on an interval.
  Exposes `pollBusy` set shared with the runner.
- **`lifecycle.js`**: `ensureRuntime` — resolves token, health-checks an existing
  runtime, spawns a child Node 22 process if absent, injects token into both
  parent and child env. When the shell runs under Bun, uses
  `WIKI_MANAGER_NODE_BIN ?? 'node'` instead of `process.execPath`.
- **`auth.js`**: Bearer token required when `--host 0.0.0.0`. Read from env
  `WIKI_MANAGER_RUNTIME_TOKEN`, then `.wiki-manager/runtime.token`, then
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

**Control lane** (`/control`): a side channel for interacting with a workspace
while a run is active, without touching the active plan. `GET /control` or
`POST /control {action:"status"}` returns run/plan/queue/approvals status plus
`controlQueue` and `controlProposals`. `POST /control {action:"explain"}` adds
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
run. `mutate` (a request to change the *active* run's plan) is recorded as a
`controlProposals` entry (`storeControlProposal`) but **not applied**
automatically — application lands in plan directeur 0.10.0's plan-patch
mechanism. **Known gap:** unlike `controlQueue`, `controlProposals` is a plain
session array, not event-sourced — it does not survive a manager restart. Bring
it in line with `controlQueue` (a `control_proposal_recorded` event + reducer
case + `store.js` persistence) before or alongside the 0.10.0 work that makes
proposals actually applicable — do not leave it as a second, lesser mechanism.
`enqueue` behaves like the existing `action:"enqueue"` path above. `ambiguous`
returns `choices` (`observe`/`mutate`/`enqueue`) instead of guessing — required
by the plan's fallback-UX rule. ShellTUI (`repl.js`) routes a busy-runtime
prompt through `action:"message"` instead of unconditionally enqueueing;
`llm-wiki`'s Agent mode chat does the same via `/api/runtime/control` (see
`llm-wiki/CLAUDE.md`).

**Config profile switching** (`/config/profiles`, `/config/use`): lists and
switches the active `.wikirc` profile for a workspace via
`applySessionWikircProfile`. `POST /config/use` is rejected with 409 while a
run is active. `llm-wiki serve` treats the manager as the canonical source for
which profile is active — see `llm-wiki/CLAUDE.md`'s Agent Runtime Integration
section for how serve re-derives its own config instead of trusting the raw
payload.

MCP `tools/call` retries transient HTTP/MCP failures. Configure globally with
`WIKI_MANAGER_MCP_RETRY_MAX_ATTEMPTS` and `WIKI_MANAGER_MCP_RETRY_BACKOFF_MS`,
or per endpoint (`retry`) and per tool (`toolRetries`) in `mcp.endpoints.json`.
The env-based defaults are resolved once and cached in `getEnvRetryPolicy()`.

**QueueStore** (`src/core/queueStore.js`): interface with `list()`, `replace()`,
`changed()`. `createMemoryQueueStore` for shell/headless sessions;
`createSqliteQueueStore` for runtime sessions. `jobQueue.js` routes through
`queueStoreFor(session)` transparently.

## Activity, Plan, Queue

All plan/activity mutations go through `dispatchAgentEvent` and the reducer in
`src/core/agentEvents.js`.

- `run_started` clears stale plan/activity state; injects a default 3-step plan
  (Analyze / Execute / Verify) owned by the orchestrator.
- `run_done` finalizes all running/pending plan steps to `done`.
- `run_evaluated` sets `state.evaluation { ok, reason, suggestedAction }`.
- `run_replanned` records `state.replans[]` entries and resets the plan.
- `run_pending_approval` sets run status to `pending_approval` in SQLite.
- `run_approved` restores run status to `running` in SQLite.
- `tool_pending_approval` / `tool_approved` track tool-level approval lifecycle.
- `plan_set` replaces the current plan.
- `activity_upserted` syncs activity and may create/replace the plan.
- `plan_step_updated` patches one step.

`/state` exposes: `status`, `plan`, `activities`, `conversation`, `evaluation`,
`replans`, `approvals`, `runs`, `queue`, `eventsCursor`.

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
- Workspace skill packages follow `depot-skills`: `skill.yaml`, `CLAUDE.md`,
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
- The host runtime listens on `127.0.0.1:7788`/`0.0.0.0:7788` depending on
  launch options and uses state under `.wiki-manager/`.
- `serve` receives `WIKI_MANAGER_RUNTIME_URL=http://host.docker.internal:7788`
  and `WIKI_MANAGER_RUNTIME_TOKEN` to connect to the runtime.
- Prefer `wiki-workspace` over raw `docker compose`.
- Keep `package.json`, MCP `clientInfo.version`, and external agent
  `_AGENT_VERSION` values aligned for each coordinated release. Current release
  line: `0.9.4`. `scripts/check-versions.js` verifies this (wired to `prepack`
  and `prepublishOnly`; `CHECK_GIT_TAG=1` and `CHECK_DOCKER_IMAGES=1` add
  optional pre-release gates). The root `build-and-push.sh` (outside this
  package) syncs versions across all six service repos before building.
- `--cacert <path>` is the supported way to trust a local proxy/private CA for
  the manager process and Docker Compose services. The file path must exist on
  the host and be readable by Docker; the certificate is mounted directly from
  that path, not copied into manager state.
- When `--cacert` is present, generated overrides live under the manager state
  directory: `.wiki-manager/cacert.compose.yml` for workspace services and
  `.wiki-manager/agents.cacert.compose.yml` for global agents. They are
  generated once on first use and never overwritten — edit freely; delete to
  regenerate from the current `--cacert` path and compose services.
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

## Commands And Validation

Common commands:

```bash
wiki-workspace config <workspace> [path]
wiki-workspace up <workspace>
wiki-workspace wiki <workspace> doctor
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
wiki-workspace runtime up
wiki-workspace runtime status
wiki-manager runtime [--host 0.0.0.0] [--port 7788] [--state-dir .wiki-manager]
# approve a pending run or tool approval from the shell:
/approve run <runId>
/approve item <itemId>
```

Headless `--skill` uses the agentic loop: run a turn, wait for active MCP
activities, then re-invoke with completed activity summary until the skill is
done or limits are reached.

`wiki-manager runtime` starts the HTTP/SSE runtime server. When launched by
`ensureRuntime` (shell path), the token is resolved before spawning and injected
via `WIKI_MANAGER_RUNTIME_TOKEN`. `wiki-workspace runtime up` writes/reuses
`WIKI_MANAGER_RUNTIME_TOKEN` in the manager `.env` so Dockerized `serve` can
call the host runtime through `host.docker.internal:7788`.
