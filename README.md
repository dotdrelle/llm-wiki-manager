# llm-wiki-manager

`llm-wiki` turns heterogeneous documentation into a living Markdown knowledge base
that AI agents can search, explore, maintain, and use to generate up-to-date
documents.

The system moves beyond classic retrieval over raw files: source material is first
converted into Markdown, ingested into a structured wiki, indexed for retrieval,
connected as a graph, then reused through build contexts and Markdown templates.
This creates a durable knowledge layer that can be rebuilt when sources evolve.

`llm-wiki-manager` is the orchestration layer for that workflow. It coordinates
workspace services, MCP endpoints, optional source exporters, and optional action
agents so several `llm-wiki` workspaces can be run from one cockpit.

The manager does not implement the `llm-wiki`, `agent-cme`, or
`agent-mailer-api` services itself. It pulls their published Docker images,
injects workspace-specific environment variables, and provides a shared Docker
Compose setup plus the `wiki-workspace` helper script.

This repository is part of a multi-repository toolchain:

| Repository | Role |
| ---------- | ---- |
| [`llm-wiki`](https://github.com/dotdrelle/llm-wiki) | Workspace engine: CLI, web UI, MCP server, retrieval, and deliverable builder |
| [`llm-wiki-manager`](https://github.com/dotdrelle/llm-wiki-manager) | Multi-workspace Docker orchestration and copy pipeline |
| [`agent-cme`](https://github.com/dotdrelle/agent-cme) | Confluence Markdown exporter exposed over MCP |
| `agent-mailer-api` | Send-only MailerSend MCP action agent |
| `agent-wiki-production` | Workspace-scoped llm-wiki production jobs exposed over MCP |

Each repository can be used separately. Together, they provide the intended Confluence -> Markdown export -> wiki ingest -> deliverable build flow.

This directory does not contain wiki data. It contains the orchestration layer:

```text
llm-wiki-manager/
├── docker-compose.yml   # shared agents + per-workspace llm-wiki services
├── wiki-workspace       # wrapper around docker compose
├── .env.example         # template for shared secrets and shared agent ports
├── workspaces/.env.example # template for workspace names, paths, ports, and copy inputs
├── SKILL.md             # agent workflow for agent-cme -> llm-wiki copy + ingest
└── .mcp.json            # local MCP client example
```

The sibling repositories provide the actual services:

```text
../agent-cme/   # Confluence -> Markdown exporter and MCP server
../agent-mailer-api/ # MailerSend send-only MCP server
../agent-wiki-production/ # llm-wiki production job MCP server
../llm-wiki/    # local-first wiki CLI, web UI, and MCP server
```

## Configure Workspaces

Create a local manager `.env` from the example, then edit shared secrets and
shared agent ports:

```bash
cp .env.example .env
```

Create one local env file per workspace:

```bash
mkdir -p workspaces
cp workspaces/.env.example workspaces/my-workspace.env
```

```env
WORKSPACE_NAME=my-workspace
WIKI_WORKSPACE_PATH=/absolute/path/to/llm-wiki-workspace
WIKI_SERVE_PORT=3100
WIKI_MCP_PORT=3101
PRODUCTION_MCP_PORT=3336
WIKI_IMPORTS=../agent-cme/data/exports/some-export-directory
```

`WIKI_IMPORTS` is optional. If it is omitted or empty, `copy` copies nothing.
Use `|` to separate several import directories. This is intentional: no
workspace should accidentally receive another workspace's exported data.

Paths may be absolute or relative to `llm-wiki-manager`. On WSL, Windows-style
paths are converted with `wslpath` when available.

`workspaces/*.env` is intentionally ignored by Git because it usually contains
local paths and workspace names. Commit only `.env.example` templates.

The manager exports these values to Docker Compose for the selected workspace:

| Workspace env variable | Purpose |
| ---------------------- | ------- |
| `WIKI_WORKSPACE_PATH` | Host workspace mounted at `/workspace` in `llm-wiki` containers |
| `WIKI_SERVE_PORT` | Host port for `wiki serve` |
| `WIKI_MCP_PORT` | Host port for `wiki mcp-http` |
| `PRODUCTION_MCP_PORT` | Host port for the workspace production MCP agent |
| `WIKI_IMPORTS` | Optional `|`-separated export directories copied by `wiki <workspace> copy` |

Do not create per-workspace `docker-compose.yml` files. `wiki init` creates workspace content and `.wikirc.yaml`; this manager owns Docker orchestration.

## Commands

List configured workspaces:

```bash
./wiki-workspace list
```

Start the shared `agent-cme` MCP server:

```bash
./wiki-workspace cme up
```

The endpoint is `http://localhost:3000/mcp/` unless `CME_MCP_PORT` is set.
Logs follow the last 100 lines by default:

```bash
./wiki-workspace cme logs
```

Start the shared MailerSend MCP action agent:

```bash
export MAILERSEND_API_KEY=...
./wiki-workspace mailer up
```

The endpoint is `http://localhost:3335/mcp/` unless `MAILER_MCP_PORT` is set.
The mailer exposes send-only tools and keeps the MailerSend API key inside the
container environment.
Logs follow the last 100 lines by default:

```bash
./wiki-workspace mailer logs
```

Start one workspace UI, its MCP endpoint, and the shared agents in the
background:

```bash
./wiki-workspace wiki my-workspace up
```

Open the workspace UI at `http://localhost:<servePort>`. The UI exposes:

- `/` for wiki browsing;
- `/graph` for the source graph with a collapsible relations panel;
- `/chat` for MCP-aware chat.

The chat page is preconfigured with the workspace `llm-wiki` MCP endpoint, the
workspace production MCP endpoint, the shared `agent-cme` MCP endpoint, and the
optional `agent-mailer-api` MCP endpoint.
The `serve` container proxies browser MCP calls server-side, so it uses the host
ports declared in `workspaces/<name>.env` plus shared agent ports:

- `WIKI_MCP_PROXY_URL=http://host.docker.internal:${WIKI_MCP_PORT}/mcp`
- `PRODUCTION_MCP_PROXY_URL=http://host.docker.internal:${PRODUCTION_MCP_PORT}/mcp/`
- `CME_MCP_PROXY_URL=http://host.docker.internal:${CME_MCP_PORT}/mcp/`
- `MAILER_MCP_PROXY_URL=http://host.docker.internal:${MAILER_MCP_PORT}/mcp/`

The shared local compose can protect MCP endpoints with distinct auth variables:

- `WIKI_MCP_ACCESS_KEY` for the workspace `llm-wiki` MCP endpoint.
- `PRODUCTION_MCP_AUTH_TOKEN`, mapped to `MCP_AUTH_TOKEN` inside `agent-wiki-production`.
- `CME_MCP_AUTH_TOKEN`, mapped to `MCP_AUTH_TOKEN` inside `agent-cme`.
- `MAILER_MCP_AUTH_TOKEN`, mapped to `MCP_AUTH_TOKEN` inside `agent-mailer-api`.

If a shared agent token is set, configure the matching bearer in the chat UI for
that server.

Initialize a workspace path if needed:

```bash
./wiki-workspace wiki my-workspace init
```

Follow the workspace logs:

```bash
./wiki-workspace wiki my-workspace logs
```

`wiki <workspace> serve` is intentionally a foreground debug mode. For normal
use, prefer `wiki <workspace> up` so the shell is not blocked.

Copy configured `agent-cme` exports into the workspace:

```bash
./wiki-workspace wiki my-workspace copy
```

Run the normal llm-wiki pipeline:

```bash
./wiki-workspace wiki my-workspace doctor
./wiki-workspace wiki my-workspace ingest
./wiki-workspace wiki my-workspace build
./wiki-workspace wiki my-workspace export
```

Inspect planned build calls before generation:

```bash
./wiki-workspace wiki my-workspace build --plan
```

Run any other `wiki` command:

```bash
./wiki-workspace wiki my-workspace run query "your question"
./wiki-workspace wiki my-workspace run index
```

## Ports

Each workspace needs unique host ports:

```env
# workspaces/first.env
WIKI_SERVE_PORT=3100
WIKI_MCP_PORT=3101
PRODUCTION_MCP_PORT=3336

# workspaces/second.env
WIKI_SERVE_PORT=3200
WIKI_MCP_PORT=3201
PRODUCTION_MCP_PORT=3436
```

`agent-cme` is shared by default on `http://localhost:3000/mcp/`.
`agent-mailer-api` is shared by default on `http://localhost:3335/mcp/`.
`agent-wiki-production` runs per workspace and uses each workspace's
`PRODUCTION_MCP_PORT`.
Workspace MCP servers use each workspace's `WIKI_MCP_PORT` and point to
`wiki mcp-http`, not to the shared agents. The browser chat uses these same
ports through the `serve` proxy instead of calling Docker-internal URLs directly.

## Data Flow

```text
Confluence
  -> agent-cme exports Markdown under ../agent-cme/data/exports/
  -> wiki-workspace copy copies selected exports to <workspace>/raw/untracked/
  -> wiki ingest updates <workspace>/wiki/ and archives sources to raw/ingested/
  -> wiki build/export creates deliverables
```

The copy step only copies Markdown files. Attachments are not copied into `raw/untracked`.

`agent-cme` writes exports under `../agent-cme/data/exports/`. `./wiki-workspace wiki <workspace> copy` copies only the export directories explicitly listed in the workspace env file; it never scans all exports automatically.

## Git Scope

`llm-wiki-manager` is intended to be its own repository. It tracks orchestration files, not generated workspace data or `agent-cme/data`.
