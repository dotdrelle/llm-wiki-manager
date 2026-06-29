# Repository Guide

## Purpose

`llm-wiki-manager` orchestrates multiple `llm-wiki` workspaces. It owns
workspace registration, Docker Compose wiring, MCP endpoint coordination, and
the `donna` agent shell.

Keep it a manager. Do not absorb responsibilities from `llm-wiki`,
`agent-cme`, `agent-wiki-production`, or other external agents.

## Layout

```text
wiki-workspace              Operator CLI around Docker Compose
docker-compose.yml          Shared workspace service stack
src/cli/wiki-manager.js     CLI entrypoint
src/shell/                  Repl/OpenTUI shell, panes, session state
src/agent/graph.js          LangGraph ReAct orchestrator
src/agent/llm.js            OpenAI-compatible client
src/commands/slash.js       Deterministic slash commands
src/core/agentEvents.js     AgentRunEvent reducer/projection
src/core/activity.js        Generic activity normalization/polling
src/core/jobQueue.js        Workspace-scoped production queue
src/core/mcp.js             MCP endpoint discovery/session/tool calls
src/core/skills.js          Workspace skill discovery
src/core/workspaces.js      Workspace registry and creation
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
- OpenTUI requires Bun and a TTY; Node/non-TTY uses `repl.js`.

Do not route natural-language input by keyword heuristics. The user controls
the route with `/chat`, `/agent`, and slash commands.

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

## Activity, Plan, Queue

All plan/activity mutations go through `dispatchAgentEvent` and the reducer in
`src/core/agentEvents.js`.

- `run_started` clears stale plan/activity state.
- `plan_set` replaces the current plan.
- `activity_upserted` syncs activity and may create/replace the plan.
- `plan_step_updated` patches one step.

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

- Prefer `wiki-workspace` over raw `docker compose`.
- Keep `package.json`, MCP `clientInfo.version`, and external agent
  `_AGENT_VERSION` values aligned for each coordinated release. Current release
  line: `0.6.47`.
- `--cacert <path>` is the supported way to trust a local proxy/private CA for
  the manager process and Docker Compose services. The file path must exist on
  the host and be readable by Docker; the certificate is mounted directly from
  that path, not copied into manager state.
- When `--cacert` is present, generated overrides live under the manager state
  directory: `.wiki-manager/cacert.compose.yml` for workspace services and
  `.wiki-manager/agents.cacert.compose.yml` for global agents. They are
  rewritten lazily before Docker Compose commands and are safe to delete.
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
```

Headless `--skill` uses the agentic loop: run a turn, wait for active MCP
activities, then re-invoke with completed activity summary until the skill is
done or limits are reached.
