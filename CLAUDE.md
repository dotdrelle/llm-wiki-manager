# Repository Guide

## Purpose

`llm-wiki-manager` is the local orchestration layer for multiple `llm-wiki`
workspaces. It owns workspace registration, Docker Compose wiring, MCP endpoint
coordination, and the `dot` agent shell.

It must stay a manager. It should not absorb the responsibilities of
`llm-wiki`, `agent-cme`, `agent-wiki-production`, or other external agents.

## Architecture

```text
wiki-workspace              Operator CLI around Docker Compose
docker-compose.yml          Shared workspace service stack
src/cli/wiki-manager.js     Node CLI entrypoint
src/shell/repl.js           Pipe shell and legacy TUI (Node fallback)
src/shell/tui.tsx           OpenTUI shell root (Bun only)
src/shell/LeftPane.tsx      Conversation view + chat input
src/shell/RightPane.tsx     Activity panel + log panel
src/shell/SlashDialog.tsx   Completion overlay
src/shell/useSession.ts     Reactive session state (SolidJS signals)
src/shell/useAgent.ts       runLine wrapper with busy/abort
src/shell/renderer.ts       Markdown stripping and line coloring helpers
src/agent/graph.js          LangGraph orchestrator
src/agent/llm.js            OpenAI-compatible chat/tool client
src/commands/slash.js       Deterministic slash commands
src/core/compose.js         Docker Compose helpers
src/core/workspaces.js      Workspace registry and creation
src/core/mcp.js             MCP endpoint discovery and tool calls
src/core/env.js             .env parser
src/core/wikirc.js          .wikirc.yaml profile loading
src/core/skills.js          Workspace skill discovery
bunfig.toml                 Bun preload for @opentui/solid
tsconfig.json               TSX compilation config (jsxImportSource = @opentui/solid)
```

## Shell Model

The interactive shell is the product surface.

- The visible agent is `dot`.
- Lines beginning with `/` execute deterministic primitives.
- Other lines go to the LangGraph orchestrator.
- `/chat <message>` is the explicit direct-chat escape hatch and must not use
  agent tools.
- Conversation history is scoped by workspace for the current process.
- The global context is used only before a workspace is loaded.
- Ctrl+C while busy aborts active LLM/MCP work; Ctrl+C when idle exits.

When changing `/use`, workspace state and conversation state must move together.
Do not reintroduce a single global message buffer for all workspaces.

### OpenTUI TUI (Bun)

When launched with Bun and a TTY is detected, the shell uses the OpenTUI-based
two-pane layout:

- **Left pane**: scrollable conversation thread + chat input at the bottom.
  Slash dialog (`/` completion overlay) opens above the input.
- **Right pane**: active MCP jobs and a live log/trace panel. MCP connection
  status remains available through `/mcp status`.

The OpenTUI TUI requires Bun (`bun start` or `bun ./bin/wiki-manager.js`).

When running under Node, or when `--legacy-tui` is passed, or when stdin/stdout
are not a TTY (headless, pipe mode), the shell falls back to `repl.js`.

The guard in `src/cli/wiki-manager.js`:

```js
const canUseOpenTui = process.versions.bun
  && process.stdin.isTTY && process.stdout.isTTY
  && !argv.includes('--legacy-tui')
  && process.env.WIKI_MANAGER_LEGACY_TUI !== '1';
```

Do not change the layout without understanding the OpenTUI box model
(`flexDirection`, `flexGrow`, `flexShrink`, `overflow`). All rendering goes
through `conversationLines` → `segmentsForLine` → `Segment[]` per line.
Color is determined on the raw (unwrapped) line and applied to all wrapped
pieces; do not evaluate `colorForRenderedLine` on wrapped fragments.

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
/skill show <name>
/skill run <name>
```

It must not become arbitrary shell execution. Do not expose `/mcp call`,
`/wiki run`, `/start`, `/stop`, `/logs`, `/exit`, or raw system commands through
this tool without a separate confirmation/allowlist design.

Do not route natural-language input away from the orchestrator by keyword
heuristics. If a fast path is needed, keep it explicit, as `/chat` is.

## Workspace Rules

- Workspaces are registered under `workspaces/`, which is gitignored.
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
- Manager `.env` is only for manager-level and external MCP settings.

## Docker Rules

- Prefer `./wiki-workspace` over raw `docker compose` so the correct project
  name, env file, ports, and volumes are used.
- Keep the default production pipeline as `ingest`, `build`, `export`, `polish`.
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
./wiki-workspace config <workspace> [path]
./wiki-workspace up <workspace>
./wiki-workspace list
./wiki-workspace wiki <workspace> doctor
./wiki-workspace wiki <workspace> ingest
./wiki-workspace wiki <workspace> build
./wiki-workspace wiki <workspace> export
./wiki-workspace cme <workspace> up
./wiki-workspace mailer status

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
- Tab completion for `/show-skill`, `/use`, etc.
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
agentic loop by default: run one agent turn, wait for active MCP activities,
then re-invoke the agent with a completed-activity summary so it can start the
next required step.

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
