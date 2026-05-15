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
| [`AgentCME`](https://github.com/dotdrelle/AgentCME) | Confluence Markdown exporter exposed over MCP |
| `agent-mailer-api` | Send-only MailerSend MCP action agent |

Each repository can be used separately. Together, they provide the intended Confluence -> Markdown export -> wiki ingest -> deliverable build flow.

This directory does not contain wiki data. It contains the orchestration layer:

```text
llm-wiki-manager/
├── docker-compose.yml   # shared agents + per-workspace llm-wiki services
├── wiki-workspace       # wrapper around docker compose
├── workspaces.example.yaml # template for workspace names, paths, ports, and copy inputs
├── SKILL.md             # agent workflow for agent-cme -> llm-wiki copy + ingest
└── .mcp.json            # local MCP client example
```

The sibling repositories provide the actual services:

```text
../agent-cme/   # Confluence -> Markdown exporter and MCP server
../agent-mailer-api/ # MailerSend send-only MCP server
../llm-wiki/    # local-first wiki CLI, web UI, and MCP server
```

## Configure Workspaces

Create a local `workspaces.yaml` from the example, then edit it:

```bash
cp workspaces.example.yaml workspaces.yaml
```

```yaml
workspaces:
  my-workspace:
    path: /absolute/path/to/llm-wiki-workspace
    servePort: 3100
    mcpPort: 3101
    imports:
      - ../agent-cme/data/exports/some-export-directory
```

`imports` is optional. If it is omitted or empty, `copy` copies nothing. This is intentional: no workspace should accidentally receive another workspace's exported data.

Paths may be absolute or relative to `llm-wiki-manager`. On WSL, Windows-style paths are converted with `wslpath` when available.

`workspaces.yaml` is intentionally ignored by Git because it usually contains local paths and workspace names. Commit only `workspaces.example.yaml`.

The manager exports these values to Docker Compose for the selected workspace:

| `workspaces.yaml` key | Compose variable | Purpose |
| --------------------- | ---------------- | ------- |
| `path` | `WIKI_WORKSPACE` | Host workspace mounted at `/workspace` in `llm-wiki` containers |
| `servePort` | `WIKI_SERVE_PORT` | Host port for `wiki serve` |
| `mcpPort` | `WIKI_MCP_HTTP_PORT` | Host port for `wiki mcp-http` |

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
shared `agent-cme` MCP endpoint, and the optional `agent-mailer-api` MCP endpoint.
The `serve` container proxies browser MCP calls server-side, so it uses the host
ports declared in `workspaces.yaml` plus shared agent ports:

- `WIKI_MCP_PROXY_URL=http://host.docker.internal:${WIKI_MCP_HTTP_PORT}/mcp`
- `CME_MCP_PROXY_URL=http://host.docker.internal:${CME_MCP_PORT}/mcp/`
- `MAILER_MCP_PROXY_URL=http://host.docker.internal:${MAILER_MCP_PORT}/mcp/`

The shared local compose can protect MCP endpoints with distinct auth variables:

- `WIKI_MCP_ACCESS_KEY` for the workspace `llm-wiki` MCP endpoint.
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

```yaml
workspaces:
  first:
    servePort: 3100
    mcpPort: 3101
  second:
    servePort: 3200
    mcpPort: 3201
```

`agent-cme` is shared by default on `http://localhost:3000/mcp/`.
`agent-mailer-api` is shared by default on `http://localhost:3335/mcp/`.
Workspace MCP servers use each workspace's `mcpPort` and point to
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

`agent-cme` writes exports under `../agent-cme/data/exports/`. `./wiki-workspace wiki <workspace> copy` copies only the export directories explicitly listed in `workspaces.yaml`; it never scans all exports automatically.

## Git Scope

`llm-wiki-manager` is intended to be its own repository. It tracks orchestration files, not generated workspace data or `agent-cme/data`.
