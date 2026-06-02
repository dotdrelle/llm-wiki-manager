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
src/shell/repl.js           Interactive TUI and pipe shell
src/agent/graph.js          LangGraph orchestrator
src/agent/llm.js            OpenAI-compatible chat/tool client
src/commands/slash.js       Deterministic slash commands
src/core/compose.js         Docker Compose helpers
src/core/workspaces.js      Workspace registry and creation
src/core/mcp.js             MCP endpoint discovery and tool calls
src/core/env.js             .env parser
src/core/wikirc.js          .wikirc.yaml profile loading
src/core/skills.js          Workspace/manager skill discovery
```

## Shell Model

The interactive shell is the product surface.

- The visible agent is `dot`.
- Lines beginning with `/` execute deterministic primitives.
- Other lines go to the LangGraph orchestrator.
- Conversation history is scoped by workspace for the current process.
- The global context is used only before a workspace is loaded.

When changing `/use`, workspace state and conversation state must move together.
Do not reintroduce a single global message buffer for all workspaces.

## Safe LLM Actions

The LLM may use:

- connected MCP tools;
- the restricted internal `shell__run_command` tool.

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

## Workspace Rules

- Workspaces are registered under `workspaces/`, which is gitignored.
- Generated workspace `.env` files, `.cme` state, exports, raw content, wiki
  output, and symlink targets must not be committed.
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

pnpm start
pnpm run check
```

## Validation

Before committing manager changes, run:

```bash
pnpm run check
```

For shell/session changes, also test at least:

```bash
printf '/use <workspace-name>\n/config status\n/workspaces\n/exit\n' | node ./bin/wiki-manager.js
```

For workspace-name validation, verify that `.`, `..`, and names containing `..`
are rejected by `/workspace init`.

## Headless Direction

`--once` is intentionally limited and does not preload a workspace.

A future scheduled mode should be explicit, for example:

```bash
wiki-manager --headless --workspace <workspace-name> --skill pipeline
```

That mode should create a normal session, call `/use`, call `/skill run`, execute
the skill without interactive confirmation, write a log file, and exit non-zero
on failure.
