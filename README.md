# llm-wiki-manager

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

`llm-wiki-manager` is the local cockpit for several `llm-wiki` workspaces.

It creates workspace folders, assigns ports, starts Docker services, exposes MCP
endpoints, and provides the `dot` shell: an agent-first terminal UI that can
inspect workspaces, run safe manager commands, call MCP tools, guide production
jobs, and run one-shot headless tasks.

The manager does not implement the wiki engine or external agents. It
orchestrates them.

## Toolchain

| Repository | Role |
| --- | --- |
| [`llm-wiki`](https://github.com/dotdrelle/llm-wiki) | Workspace engine: CLI, web UI, MCP server, retrieval, deliverables, skills |
| [`llm-wiki-manager`](https://github.com/dotdrelle/llm-wiki-manager) | Multi-workspace cockpit, Docker orchestration, `dot` shell |
| [`agent-cme`](https://github.com/dotdrelle/agent-cme) | Workspace-scoped Confluence to Markdown exporter |
| [`agent-wiki-production`](https://github.com/dotdrelle/agent-wiki-production) | Workspace-scoped production jobs: ingest, build, export, polish, pipeline |
| [`agent-mailer-api`](https://github.com/dotdrelle/agent-mailer-api) | Optional external mailer MCP endpoint |

## Workspace Model

Each managed workspace is a normal `llm-wiki` workspace plus manager metadata:

```text
workspaces/<name>/
  .env                 # ports, tokens, workspace path
  .cme/                # Confluence exporter state
  .wikirc.yaml         # LLM/vector config for this workspace
  raw/
  wiki/
  templates/
  build-context/
  deliverables/
  .wiki/
```

The `.env` file is manager-owned. The `.wikirc.yaml` file is workspace-owned and
stores provider/model/baseUrl/apiKey/retrieval settings.

Confluence exports land directly in:

```text
raw/untracked/
```

The normal production pipeline starts at ingest:

```text
ingest -> build -> export -> polish
```

The legacy copy step is only for deployments that explicitly configure external
import mappings.

## Initial Setup

```bash
corepack enable
pnpm install
cp .env.example .env
```

Create a workspace:

```bash
./wiki-workspace config my-project [path]
```

Start it:

```bash
./wiki-workspace up my-project
```

Run wiki commands:

```bash
./wiki-workspace wiki my-project doctor
./wiki-workspace wiki my-project ingest
./wiki-workspace wiki my-project build --plan
./wiki-workspace wiki my-project build
```

## Services

The shared `docker-compose.yml` starts one workspace stack:

| Service | Role | Port variable |
| --- | --- | --- |
| `serve` | Wiki web UI and browser chat | `WIKI_SERVE_PORT` |
| `mcp-http` | llm-wiki MCP endpoint | `WIKI_MCP_PORT` |
| `cme-mcp` | Confluence exporter MCP endpoint | `CME_MCP_PORT` |
| `production-mcp` | Production job MCP endpoint | `PRODUCTION_MCP_PORT` |

Use `wiki-workspace` whenever possible so Compose receives the right project
name, env file, ports, and volume mounts.

```bash
./wiki-workspace list
./wiki-workspace up my-project
./wiki-workspace wiki my-project logs
./wiki-workspace cme my-project up
./wiki-workspace cme my-project logs
./wiki-workspace mailer status
```

## The `dot` Shell

Start the agent shell:

```bash
bun start          # full OpenTUI shell (requires Bun ≥ 1.2)
pnpm start         # alias for bun start
pnpm run start:node  # fallback: legacy repl.js shell under Node
```

The shell is agent-first:

- input starting with `/` runs a deterministic shell primitive;
- any other input goes to the LangGraph orchestrator;
- `/chat <message>` bypasses agent tools for direct LLM chat;
- the visible agent name is `dot`;
- conversation history is separated per workspace;
- Ctrl+C interrupts active LLM/MCP calls; Ctrl+C twice exits when idle.

The TUI uses a two-pane layout:

- **Left** — scrollable conversation thread with a chat input at the bottom.
  Typing `/` opens a slash-command completion overlay just above the input.
  PageUp/PageDown and mouse scroll move through the conversation.
- **Right** — connected MCP servers (● / ◐ / ○) and a live log/trace panel.

Useful primitives:

```text
/workspaces
/new <name> [path]
/use <workspace>
/config list
/config use <name>
/config status
/services
/start [service]
/stop [service]
/logs <service>
/mcp endpoints
/mcp status
/mcp tools [mcp]
/mcp call <mcp> <tool> [json]
/wiki
/wiki run <args...>
/skills
/show-skill <name>
/run-skill <name>
/chat <message>
/clear
```

Skills are loaded only from the active workspace. The manager itself has no
root `SKILL.md` and no root `skills/` directory.

A workspace skill follows the `depot-skills` structure:

```text
workspaces/<name>/
  skill.yaml
  CLAUDE.md
  templates/
  build-context/
  .wiki/
    system-prompt.md
    skills/
      <command>.md
```

`skill.yaml` declares the workspace skill metadata and entrypoints. The manager
uses `entrypoints.uiSkillDir` for executable shell skills, defaulting to
`.wiki/skills`, and `entrypoints.claude` for the workspace context body,
defaulting to `CLAUDE.md`.

Workspace switching is isolated. When you run:

```text
/use juno
```

the shell switches both the displayed conversation and the LLM history to
`juno`. Returning to another workspace restores that workspace's in-memory
conversation for the current shell process.

## Agent Tooling

The LLM can call MCP tools directly when they are connected.

It can also call an internal restricted tool:

```text
shell__run_command
```

This tool can run only safe manager slash commands:

```text
/workspaces
/new <name> [path]
/use <workspace>
/config ...
/status
/services
/skills
/show-skill <name>
/run-skill <name>
```

It is not a general shell. It does not expose arbitrary system commands, `/mcp
call`, `/wiki run`, `/start`, `/stop`, `/logs`, or `/exit`.

This keeps the LLM useful for workspace navigation and inspection without giving
it unrestricted command execution.

## Non-Interactive Mode

The existing `--once` mode runs one agent turn:

```bash
node ./bin/wiki-manager.js --once "list configured workspaces"
```

It is intentionally lightweight and does not preload a workspace, LLM config, or
MCP endpoints.

Scheduled unattended execution uses headless mode, not `--once`:

```bash
node ./bin/wiki-manager.js --headless --workspace my-project --skill pipeline
node ./bin/wiki-manager.js --headless --workspace my-project --prompt "check production status"
```

Headless mode creates a normal session, runs `/use`, executes one skill or
prompt through the orchestrator, writes a log under `.wiki/logs/` by default,
and exits non-zero on failure.

Use `--log-file <path>` to choose a specific log path. When a workspace has
loaded successfully, failures are still written to the headless log before the
process exits non-zero.

## Local Compose Overrides

Do not put machine-specific settings in the shared `docker-compose.yml`.

For example, if a VPN/proxy requires a custom CA bundle, create a local ignored
override such as:

```text
docker-compose.ca.local.yml
```

and run:

```bash
docker compose \
  -p wiki-my-project \
  -f docker-compose.yml \
  -f docker-compose.ca.local.yml \
  --env-file workspaces/my-project/.env \
  up -d serve production-mcp
```

Files matching `docker-compose*.local.yml` are ignored by Git.

## Security Model

- Workspace names created by `/workspace init` are path-safe identifiers:
  alphanumeric at both ends, only letters/digits/underscore/dot/dash inside, and
  no `..` sequence.
- Manager MCP tokens are local coordination secrets. They are stored in memory
  for local calls and are not displayed by status commands.
- Provider API keys belong in the workspace `.wikirc.yaml` or in the owning
  service environment, not in manager-level docs.
- Clipboard copy uses `execFileSync`, not shell-string execution.
- `.wikirc.yaml` is parsed as YAML `core` schema and must be an object.
- `.env` quoted values support basic escapes such as `\"`, `\\`, `\n`, `\r`,
  and `\t`.

## Development

```bash
pnpm install
pnpm start
pnpm run check
```

`pnpm run check` verifies:

- CLI version;
- help output;
- limited `--once` mode.

For headless changes, also test a controlled error path, for example:

```bash
node ./bin/wiki-manager.js --headless --workspace __missing__ --prompt test
```

## Repository Layout

```text
llm-wiki-manager/
├── bin/wiki-manager.js
├── bunfig.toml             # Bun preload for @opentui/solid
├── tsconfig.json           # TSX compilation (jsxImportSource = @opentui/solid)
├── src/
│   ├── agent/              # LangGraph orchestration and LLM client
│   ├── cli/                # CLI entrypoint
│   ├── commands/           # slash commands
│   ├── core/               # compose, env, MCP, skills, workspace registry
│   └── shell/
│       ├── repl.js         # legacy TUI and pipe shell (Node fallback)
│       ├── tui.tsx         # OpenTUI shell root (Bun)
│       ├── LeftPane.tsx    # conversation view + chat input
│       ├── RightPane.tsx   # MCP server list + log panel
│       ├── SlashDialog.tsx # completion overlay
│       ├── useSession.ts   # reactive session state
│       ├── useAgent.ts     # agent call wrapper
│       └── renderer.ts     # markdown stripping and line coloring
├── docker-compose.yml
├── wiki-workspace
├── workspaces/             # gitignored local workspace registry
├── .env.example
└── workspaces/.env.example
```

## License

Released under the PolyForm Noncommercial License 1.0.0. See `LICENSE`.
