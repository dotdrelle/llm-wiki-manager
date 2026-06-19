# Repository Guide

## Purpose

`llm-wiki-manager` is the local orchestration layer for multiple `llm-wiki`
workspaces. It owns workspace registration, Docker Compose wiring, MCP endpoint
coordination, and the `donna` agent shell.

It must stay a manager. It should not absorb the responsibilities of
`llm-wiki`, `agent-cme`, `agent-wiki-production`, or other external agents.

## Architecture

```text
wiki-workspace              Operator CLI around Docker Compose
docker-compose.yml          Shared workspace service stack
src/cli/wiki-manager.js     CLI entrypoint: interactive, headless, --once
src/shell/repl.js           Pipe shell + Node TUI fallback; runLine/runAgentTurn; session._onStream
src/shell/tui.tsx           OpenTUI shell root (Bun only)
src/shell/LeftPane.tsx      Conversation view + chat input
src/shell/RightPane.tsx     Activity panel + log panel
src/shell/SlashDialog.tsx   Completion overlay
src/shell/useSession.ts     Reactive session state (SolidJS signals)
src/shell/useAgent.ts       runLine wrapper with busy/abort
src/shell/renderer.ts       Markdown stripping and line coloring helpers
src/agent/graph.js          LangGraph ReAct orchestrator (MAX_TOOL_ITERATIONS=80)
src/agent/llm.js            OpenAI-compatible client: complete, completeWithTools, streamWithTools, stream
src/commands/slash.js       Deterministic slash commands
src/core/agentEvents.js     Event system: createAgentEvent, dispatchAgentEvent, reduceAgentEvents; typed AgentRunEvent projection
src/core/activity.js        Generic activity registry: extractActivity, normalizeActivity, poll contract
src/core/jobQueue.js        In-memory production_start_job queue and scheduler helpers
src/core/compose.js         Docker Compose helpers
src/core/workspaces.js      Workspace registry and creation
src/core/mcp.js             MCP endpoint discovery, persistent session, tool calls
src/core/env.js             .env parser
src/core/wikirc.js          .wikirc.yaml profile loading
src/core/skills.js          Workspace skill discovery
bunfig.toml                 Bun preload for @opentui/solid
tsconfig.json               TSX compilation config (jsxImportSource = @opentui/solid)
```

## Shell Model

The interactive shell is the product surface.

- The visible agent is `donna`.
- Lines beginning with `/` execute deterministic primitives.
- Startup defaults to agentic mode: free-text lines go to the LangGraph
  orchestrator with MCP tools.
- `/chat` switches free text to direct LLM chat without tools. Direct chat
  requires an active workspace `.wikirc` profile with `llm.apiKey`,
  `llm.model`, and `llm.baseUrl`; otherwise the shell should explain the
  missing setup and point to `/use`, `/config list`, `/config use`, or
  `/config edit`.
- `/agent` switches free-text lines back to the LangGraph orchestrator.
- The active mode is persistent for the current session and is visible in the
  OpenTUI left-pane header and input prompt.
- Conversation history is scoped by workspace for the current process.
- The global context is used only before a workspace is loaded.
- Ctrl+C while busy aborts active LLM/MCP work; Ctrl+C when idle exits.
- OpenTUI should not require mode switching for normal reading. Mouse wheel
  scrolls the conversation, and OpenTUI selection copies selected text through
  OSC52/platform clipboard fallback. Message headers also expose a small
  `[ copy ]` mouse target that copies that message content. PageUp/PageDown
  remain keyboard scrolling fallbacks.

When changing `/use`, workspace state and conversation state must move together.
Do not reintroduce a single global message buffer for all workspaces.

### OpenTUI TUI (Bun)

When launched with Bun and a TTY is detected, the shell uses the OpenTUI-based
two-pane layout:

- **Left pane**: scrollable conversation thread + chat input at the bottom.
  Slash dialog (`/` completion overlay) opens above the input.
- **Right pane**: Plan/Queue tabs, active MCP jobs, and a live log/trace panel.
  `Ctrl+Q` toggles Plan/Queue, and clicking the tab labels selects a specific
  tab. MCP connection status remains available through `/mcp status`.

The OpenTUI TUI requires Bun (`bun start` or `bun ./bin/wiki-manager.js`).

When running under Node, or when `--legacy-tui` is passed, or when stdin/stdout
are not a TTY (headless, pipe mode), the shell falls back to `repl.js`.

The guard in `src/cli/wiki-manager.js`:

```js
if (process.stdin.isTTY && process.stdout.isTTY) {
  if (!process.versions.bun) throw new Error('Interactive TUI requires Bun.');
  const { runOpenTuiShell } = await import('../shell/tui.tsx');
  await runOpenTuiShell({ agent, packageJson });
  return;
}
// Non-TTY or Node → repl.js pipe/legacy shell
await runShell({ agent, packageJson });
```

Do not change the layout without understanding the OpenTUI box model
(`flexDirection`, `flexGrow`, `flexShrink`, `overflow`). All rendering goes
through `conversationLines` → `segmentsForLine` → `Segment[]` per line.
Color is determined on the raw (unwrapped) line and applied to all wrapped
pieces; do not evaluate `colorForRenderedLine` on wrapped fragments.

### Agent Orchestration

The `donna` LangGraph graph is a ReAct loop compiled from two nodes:

```
START → orchestratorNode
          ├── no LLM configured → buildLimitedAgentResponse, END
          ├── cap reached (MAX_TOOL_ITERATIONS = 80) → cap message, END
          ├── streamWithTools available (normal path):
          │     ├── tool_calls in stream → toolExecutorNode → orchestratorNode (loop)
          │     └── text only → streamed inline via session._onStream, streamedInline=true, END
          └── completeWithTools fallback (streamWithTools unavailable):
                ├── tool_calls → toolExecutorNode → orchestratorNode (loop)
                ├── stream available → readyToStream=true + streamContext, END
                └── no stream → response=content, END

toolExecutorNode
  ├── shell__run_command  → handleSlashCommand (safe subset only)
  ├── wiki__plan_set      → dispatchAgentEvent('plan_set') → applyAgentProjectionToSession → session.headlessPlan
  ├── wiki__plan_done     → dispatchAgentEvent('plan_step_updated') → applyAgentProjectionToSession
  └── <server>__<tool>    → callMcpTool → JSON-RPC Streamable HTTP
                            emits: tool_call_started · tool_call_result
                            if _activity in result: activity_upserted
                            if no plan exists yet: plan_set (minimal 1-step, _activityKey:null)

`callMcpTool` (in `src/core/mcp.js`) auto-injects `configPath` from
`endpoint.activeConfigPath` for `production_start_job` when `args.configPath`
is absent. `endpoint.activeConfigPath` is kept in sync with
`session.wikirc.fileName` by `loadSessionWikirc()` in `slash.js`.

The MCP Streamable HTTP initialize payload includes a `clientInfo.version`.
When bumping `package.json`, keep that version in `src/core/mcp.js` in sync so
MCP server logs and client handshakes report the published manager version.

`graph.js toolExecutorNode` additionally injects `callerLabel:
"<workspace>/wiki-manager"` for `production_start_job` calls that lack one,
so the MCP server can log the originating workspace/agent.

MCP tool errors are surfaced as `Error [<server>.<tool>]: <message>` so log
readers can identify which MCP container failed without inspecting Docker logs
directly.
```

Important: `wiki__plan_set` and `wiki__plan_done` are the only internal
`wiki__*` tools. Remote llm-wiki MCP tools are still namespaced as
`wiki__wiki_list_pages`, `wiki__wiki_read_page`, etc. Do not route the whole
`wiki__*` namespace to `handleWikiTool`; only the two plan tools are internal.

**Session callbacks:**

- `session._onStep(label)` — set per-turn before `agent.invoke()`, deleted in `finally`; step-level updates (spinner label, activity panel lines)
- `session._onStream(delta)` — set per-turn before `agent.invoke()`, deleted in `finally`; raw text delta from `streamWithTools`; caller accumulates into a `donnaMessage` pushed to conversation
- `session._onStreamReset()` — set per-turn before `agent.invoke()`, deleted in `finally`; called when a streamed assistant turn resolves to tool calls. If the streamed donna bubble already has content, keep it and append a blank separator so intermediate text and the final answer stay in one bubble; remove only empty stream placeholders.
- `session._onPlanUpdate()` — set once at session mount by `useSession.ts` to SolidJS `refresh`; called by `dispatchAgentEvent` whenever `session.headlessPlan` changes (JSON diff guard). Only events in `SESSION_PROJECTION_EVENTS` (`run_started`, `plan_set`, `plan_step_updated`, `activity_upserted`, `run_error`) trigger `applyAgentProjectionToSession`; `assistant_delta` does not.

**Activity surfacing (interactive TUI):**

- `toolExecutorNode` dispatches `activity_upserted` for each MCP result that carries `_activity`. The `agentEvents.js` reducer upserts into `state.activities` and syncs the plan.
- `session.activities` is a projection copy derived by `applyAgentProjectionToSession`; `session.productionActivity` is a compat mirror for the latest production job.
- Background `setInterval` in `useSession.ts` (OpenTUI) and `wiki-manager.js` (headless) polls non-terminal activities. Each poll result that carries `_activity` dispatches `activity_upserted` through `dispatchAgentEvent`; the reducer handles plan synchronization.
- **ActivityPanel rendering** (`RightPane.tsx`):
  - Line 1 (title): `progress.label` when present (specific, e.g. "Ingest my-doc.md"), falling back to `activity.label`.
  - Line 2 (status): `status · progress.detail` when present (e.g. "running · Préparation LLM", "running · Source 3/10", "running · LLM en attente quota, reprise dans 45s"), falling back to `status · phase`.
  - Line 3: source · id · age.
  - Percent badge on line 2 from `progress.percent`.
- **LogPanel**: `useSession.ts` records each `progress.detail` change with a timestamp and the `progress.label` as prefix, giving a timestamped trace of what each job was doing (e.g. LLM call timing).
- When the Plan panel can associate itself with an activity that has an id, its title should prefer `Plan : Job <id>` over repeating the activity label, since progress details already appear in Activity/log panels.

**Production job queue (interactive TUI):**

- `src/core/jobQueue.js` owns an in-memory, workspace-scoped queue for
  `production_start_job` only.
- The MCP server lock remains the source of truth. The manager queues only when
  a production job is already active locally or when `production_start_job`
  returns `workspace_busy`.
- Queue item states are `waiting`, `starting`, `running`, `done`, `failed`, and
  `cancelled`.
- Scheduler trigger: when existing activity polling observes a production
  activity transition to a terminal state, call `startNextQueuedJob()`. A light
  10s fallback in `useSession.ts` runs only when at least one item is waiting.
- Workspace scope is strict. Items from other workspaces are frozen until the
  user switches back to that workspace.
- `/queue` lists queue items, `/queue cancel <id>` removes waiting/starting
  items or calls `production_cancel_job` for running production jobs, and
  `/queue clear` removes finished items for the current workspace.
- The RightPane Queue tab shows the short queue id, status, compact production
  args, workspace/job id, and frozen warning. It is an operator view, not a
  replacement for MCP locks.
- Do not add `/queue retry` in V1; stale arguments should be resubmitted
  manually.

**Plan tracking (interactive and headless):**

All plan mutations go through `dispatchAgentEvent` in `src/core/agentEvents.js`. The reducer (`applyEvent`) is the single source of truth:

- `run_started` clears `state.plan` and `state.activities` — prevents stale plan from a previous turn bleeding into the new one.
- `plan_set` (from `wiki__plan_set` or minimal MCP plan) replaces the current plan.
- `activity_upserted` calls `ensurePlanFromActivityProjection` (key-based guard): same `_activityKey` = polling update, skip; different key or `null` key = new job, replace.
- `plan_step_updated` (from `wiki__plan_done`) patches a single step status.
- `session.headlessPlan` is a compat projection copy written by `applyAgentProjectionToSession`.

Usage rules:
- Prefer MCP tools that declare `_activity.plan.steps`; the shell creates the plan automatically from the `activity_upserted` event.
- Call `wiki__plan_set(steps)` only when the tool has no `_activity` or the task spans multiple independent tools.
- For MCP tools that don't return `_activity`, a minimal 1-step plan (`_activityKey: null`) is automatically emitted before the call so the Plan panel shows immediate feedback. A real `activity_upserted` with a non-null key replaces it.
- In headless: fallback `extractHeadlessPlan` parses a numbered list from the first turn's text response if the agent did not call `wiki__plan_set`.
- Each turn: agent calls `wiki__plan_done(step, status)` for synchronous steps;
  async MCP jobs are matched to plan steps first by structured fields
  (`progress.stepId`, `progress.stepIndex`) and then by legacy token overlap.
- Re-invocation prompt (headless agentic loop): original task + `formatPlanStatus` (`[✓]`/`[✗]`/`[ ]`) + completed activities summary.
- If a headless turn starts no async activity but the plan still has pending steps, re-invoke the agent with plan status instead of declaring completion. This supports synchronous setup/config/mailer steps.
- Production ingest/build/export/polish should normally be represented as one plan step backed by one `production_start_job(type="pipeline", steps=[...])`; do not split those internal production phases into separate manager-level async steps unless they will be launched as separate jobs intentionally.

## Safe LLM Actions

The LLM may use:

- connected MCP tools;
- the restricted internal `shell__run_command` tool.

For actionable requests, the orchestrator must not answer with future intent
only. If a connected MCP tool or safe primitive can perform the action, call it
in the same turn. If required arguments are missing, ask for the exact missing
values. If the tool/server is unavailable, name the concrete blocker.

CME setup/configuration is synchronous. It should call `cme_status`/`cme_setup`
directly when CME tools are connected and credentials are available. Do not rely
on the Activity panel for setup calls; Activity only resumes long-running jobs
that return `_activity`, such as CME exports or production jobs.

`shell__run_command` is limited to safe manager slash commands:

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

It must not become arbitrary shell execution. Do not expose `/mcp call`,
`/wiki run`, `/start`, `/stop`, `/logs`, `/exit`, or raw system commands through
this tool without a separate confirmation/allowlist design.

Do not route natural-language input by keyword heuristics. The user controls
the route explicitly with `/chat` and `/agent`.

## Workspace Rules

- Workspaces are registered under `./workspaces/` relative to the directory
  where `wiki-manager` or `wiki-workspace` is launched, unless
  `WIKI_WORKSPACES_DIR` overrides it. In the repo, `workspaces/` is gitignored.
- Generated workspace `.env` files, `.cme` state, exports, raw content, wiki
  output, and symlink targets must not be committed.
- The manager must not contain a root `SKILL.md` or a root `skills/` directory.
- Workspace skills must follow the `depot-skills` layout: `skill.yaml`,
  `CLAUDE.md`, `templates/`, `build-context/`, `.wiki/system-prompt.md`, and
  executable UI skills under `.wiki/skills/` unless `skill.yaml` declares
  another `entrypoints.uiSkillDir`.
- Workspace names created by `/workspace init` must be path-safe:
  alphanumeric at both ends, only letters/digits/underscore/dot/dash inside, and
  no `..`.
- LLM/vector provider config belongs in each workspace `.wikirc.yaml`.
- The only valid `.env` per workspace is `workspaces/<name>/.env`. There is no global manager `.env`. External MCP endpoints go in `mcp.endpoints.json` (gitignored; commit `mcp.endpoints.example.json` as template).

## Docker Rules

- Prefer `wiki-workspace` over raw `docker compose` so the correct project
  name, env file, ports, and volumes are used. Use `./wiki-workspace` only when
  working directly from the source checkout.
- Keep the default production pipeline as `ingest`, `build`, `export`, `polish`.
- For production builds where existing deliverables should remain stable, pass
  `stabilize: true` to `production_start_job`; this applies only to build steps
  and preserves unchanged sections from the previous deliverable.
- The legacy `copy` step is only for deployments that explicitly configure
  import mappings.
- Do not put machine-specific settings in `docker-compose.yml`.
- Use ignored local overrides such as `docker-compose.ca.local.yml` for custom
  CA bundles, VPN/proxy settings, or other host-specific compose changes.

## Security Rules

- MCP auth tokens are local coordination secrets. They may live in memory but
  must not be logged or serialized as part of a full session dump.
- Status output must not print token values.
- Clipboard handling should use `execFileSync` with argv arrays, not shell
  strings.
- `.wikirc.yaml` loading should reject invalid YAML and non-object roots.
- `.env` parsing should preserve quoted values and handle basic escapes.

## Common Commands

```bash
wiki-workspace config <workspace> [path]
wiki-workspace up <workspace>
wiki-workspace list
wiki-workspace wiki <workspace> doctor
wiki-workspace wiki <workspace> ingest
wiki-workspace wiki <workspace> build
wiki-workspace wiki <workspace> export
wiki-workspace cme <workspace> up
wiki-workspace mailer status

bun start                   # full OpenTUI shell (requires Bun)
pnpm start                  # alias for bun start
pnpm run start:node         # legacy repl.js shell (Node)
pnpm run check
node ./bin/wiki-manager.js --headless --workspace <workspace-name> --prompt "check production status"
```

## Validation

Before committing manager changes, run:

```bash
pnpm run check
```

For OpenTUI shell changes, launch with Bun and exercise the golden path:
- Tab completion for `/skills show`, `/use`, etc.
- Conversation scroll (mouse wheel or PageUp/PageDown)
- Slash dialog navigation (up/down, Tab to complete, Esc to dismiss)
- Ctrl+C interrupts a busy agent; Ctrl+C again exits when idle

For shell/session changes under Node, also test at least:

```bash
printf '/use <workspace-name>\n/config status\n/workspaces\n/exit\n' | node ./bin/wiki-manager.js
```

For headless changes, test an error path that does not require provider access:

```bash
node ./bin/wiki-manager.js --headless --workspace __missing__ --prompt test
```

For workspace-name validation, verify that `.`, `..`, and names containing `..`
are rejected by `/workspace init`.

## Headless Mode

`--once` is intentionally limited and does not preload a workspace.

Use explicit headless mode for scheduled runs:

```bash
wiki-manager --headless --workspace <workspace-name> --skill pipeline
wiki-manager --headless --workspace <workspace-name> --prompt "check production status"
```

Headless mode creates a normal session, calls `/use`, and writes a log file.
`--prompt` runs one agent turn unless `--wait` is passed. `--skill` uses the
agentic loop by default: run one agent turn, wait for active MCP activities
(polled via `_activity.poll`), then re-invoke the agent with a
completed-activity summary so it can start the next required step.

`runHeadlessAgentTurn` sets `session._onStream` to accumulate streamed deltas
before calling `agent.invoke()`, then handles `streamedInline` (primary path),
`response` (limited/error), or `readyToStream` (fallback) in that order.

Headless controls:

```bash
wiki-manager --headless --workspace <workspace-name> --skill pipeline --timeout 3600 --max-turns 20
wiki-manager --headless --workspace <workspace-name> --skill pipeline --no-wait
wiki-manager --headless --workspace <workspace-name> --prompt "check production status" --wait
```

`--timeout` is per wave of active jobs, not a global run timeout. `--max-turns`
limits LLM turns in the agentic loop. Exit non-zero on failed/cancelled
activities, activity timeout, max-turn exhaustion, setup failure, or missing
workspace/LLM config.

Use `--log-file <path>` when tests need to assert log creation without touching
a workspace. Headless mode should keep using the same safe primitives and MCP
tooling as the interactive orchestrator.

## MCP Activity Contract

The manager must remain MCP-agnostic. Do not hard-code future job tracking
around specific agents unless it is a temporary legacy adapter. Any MCP can opt
into manager monitoring by returning additive `_activity` metadata alongside its
native payload:

```json
{
  "_activity": {
    "id": "job-123",
    "source": "production",
    "kind": "pipeline",
    "label": "Production pipeline",
    "status": "running",
    "progress": { "percent": 42, "step": "build" },
    "poll": {
      "server": "production",
      "tool": "production_job_status",
      "args": { "jobId": "job-123" },
      "intervalMs": 2500
    },
    "startedAt": "2026-06-05T12:00:00Z",
    "updatedAt": "2026-06-05T12:03:00Z",
    "error": null,
    "terminal": false
  }
}
```

Native response shapes must stay backwards compatible. `_activity` is additive.
If `poll` is present, shell/TUI and headless mode may call that MCP tool until
the activity becomes terminal.
