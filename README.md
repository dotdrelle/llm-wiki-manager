# llm-wiki-manager

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

<p align="center">
  <img src="https://www.itsdonna.events/assets/LocalFirstAIKnowledgeCore.png" alt="Donna local-first AI knowledge core architecture" width="760">
</p>

`llm-wiki` turns heterogeneous documentation into a living Markdown knowledge base
that AI agents can search, explore, maintain, and use to generate up-to-date
documents.

`llm-wiki-manager` is the orchestration layer for that workflow. It coordinates
workspace services, MCP endpoints, a Confluence exporter, and production jobs so
several `llm-wiki` workspaces can be run from one cockpit.

The manager does not implement the `llm-wiki`, `agent-cme`, or
`agent-wiki-production` services itself. It pulls their published Docker images,
injects workspace-specific environment variables, and provides a shared Docker
Compose setup plus the `wiki-workspace` helper script. `agent-mailer-api` is
external infrastructure: the manager only passes its MCP URL and bearer token to
`llm-wiki serve`.

This repository is part of a multi-repository toolchain:

| Repository | Role |
| ---------- | ---- |
| [`llm-wiki`](https://github.com/dotdrelle/llm-wiki) | Workspace engine: CLI, web UI, MCP server, retrieval, and deliverable builder |
| [`llm-wiki-manager`](https://github.com/dotdrelle/llm-wiki-manager) | Multi-workspace Docker orchestration |
| [`agent-cme`](https://github.com/dotdrelle/agent-cme) | Confluence Markdown exporter exposed over MCP |
| [`agent-mailer-api`](https://github.com/dotdrelle/agent-mailer-api) | External send-only MailerSend MCP action agent |
| [`agent-wiki-production`](https://github.com/dotdrelle/agent-wiki-production) | Workspace-scoped llm-wiki production jobs exposed over MCP |

---

## Workspace model

Each workspace is a self-contained directory:

```text
workspaces/my-project/
  .env                 # ports, workspace path, MCP tokens (auto-generated)
  .cme/                # agent-cme credentials and state
  raw/
    untracked/         # CME writes exports here directly
    ingested/          # wiki ingest archives processed sources here
  wiki/                # structured wiki pages
  templates/           # deliverable templates
  build-context/       # generated build context
  .wikirc.yaml         # provider/model/baseUrl/apiKey config (created by wiki init)
```

`agent-cme` exports land directly in `raw/untracked/` via a Docker volume mount —
no copy step needed.
For that reason, manager production pipelines do not include the legacy
`copy` step by default; the normal sequence starts at `ingest`.

---

## Repository layout

```text
llm-wiki-manager/
├── docker-compose.yml          # shared compose for all workspace services
├── wiki-workspace              # CLI wrapper around docker compose
├── .env.example                # template for shared manager settings and external mailer URL/token
├── workspaces/.env.example     # template for per-workspace configuration
├── SKILL.md                    # agent skill: Confluence → wiki pipeline
└── workspaces/                 # per-workspace config (gitignored)
    └── <name>/
        └── .env
```

---

## Initial setup

Copy the shared manager env for shared orchestration settings:

```bash
cp .env.example .env
```

LLM and vector provider settings, including `apiKey`, live in each workspace's
`.wikirc.yaml`. The manager `.env` is for shared settings such as optional
production guards and the external mailer endpoint consumed by `serve`.

---

## Create a workspace

```bash
./wiki-workspace config my-project [path]
```

This command:

1. Creates `workspaces/my-project/` with `.cme/` and `raw/untracked/`
2. Auto-selects four free host ports (serve, mcp, cme, production)
3. Writes `workspaces/my-project/.env`
4. Runs `wiki init` inside the workspace via Docker

Edit the generated `.env` to adjust ports if needed.

If `path` is omitted, the workspace is created under
`workspaces/my-project/`. If `path` points somewhere else, the manager creates a
symlink at `workspaces/my-project` so later commands can still address the
workspace by name:

```bash
./wiki-workspace config my-project /absolute/path/to/my-project
./wiki-workspace up my-project
```

---

## Start a workspace

```bash
./wiki-workspace up my-project
```

Starts the workspace stack: wiki UI, wiki MCP, production MCP, and workspace CME.
The mailer is external; `serve` connects to it through `MAILER_MCP_PROXY_URL`.

| Service | Port variable |
| ------- | ------------- |
| Wiki UI + chat | `WIKI_SERVE_PORT` |
| Wiki MCP | `WIKI_MCP_PORT` |
| CME MCP | `CME_MCP_PORT` |
| Production MCP | `PRODUCTION_MCP_PORT` |

---

## Commands

List configured workspaces:

```bash
./wiki-workspace list
```

Create a workspace:

```bash
./wiki-workspace config my-project [./workspaces/my-project]
```

Start the full stack:

```bash
./wiki-workspace up my-project
```

Start only wiki services (no CME):

```bash
./wiki-workspace wiki my-project up
```

Run the web UI in the foreground without starting CME:

```bash
./wiki-workspace wiki my-project serve
```

Start CME manually when the workspace needs it:

```bash
./wiki-workspace cme my-project up
./wiki-workspace wiki my-project serve
```

Manage workspace CME:

```bash
./wiki-workspace cme my-project up
./wiki-workspace cme my-project logs
./wiki-workspace cme my-project down
```

Check the external mailer configuration:

```bash
./wiki-workspace mailer status
```

Run the wiki pipeline:

```bash
./wiki-workspace wiki my-project doctor
./wiki-workspace wiki my-project ingest
./wiki-workspace wiki my-project build --plan
./wiki-workspace wiki my-project build
./wiki-workspace wiki my-project export
```

Follow logs:

```bash
./wiki-workspace wiki my-project logs
./wiki-workspace cme my-project logs
```

Stop a workspace:

```bash
./wiki-workspace wiki my-project down
```

Run any wiki CLI command:

```bash
./wiki-workspace wiki my-project run query "your question"
./wiki-workspace wiki my-project run index
```

---

## Data flow

```text
Confluence
  -> cme_export_run()
  -> <workspace>/raw/untracked/     (written directly by CME via Docker volume)
  -> wiki ingest                    (processes raw/untracked, archives to raw/ingested)
  -> wiki build / export            (generates deliverables)
```

---

## Ports

Each workspace receives a block of four host ports in a 100-port slice. The
first workspace uses `31xx`, the second uses `32xx`, then `33xx`, and so on:

```env
# workspaces/first/.env
WIKI_SERVE_PORT=3100
WIKI_MCP_PORT=3101
CME_MCP_PORT=3102
PRODUCTION_MCP_PORT=3103

# workspaces/second/.env
WIKI_SERVE_PORT=3200
WIKI_MCP_PORT=3201
CME_MCP_PORT=3202
PRODUCTION_MCP_PORT=3203
```

`./wiki-workspace config` selects the first fully free slice automatically.
Edit the workspace `.env` to change them.

---

## MCP auth tokens

MCP auth tokens are local coordination secrets used by the manager, workspace
services, and local MCP clients to authenticate internal calls between local
endpoints. They are not API keys for MailerSend, Atlassian, or model providers.

The values below are examples of the expected `.env` keys. Generate or choose
your own tokens for each local deployment; do not copy the empty placeholders as
production values.

External transverse MCP endpoints live in the root manager `.env`:

```env
MAILER_MCP_PROXY_URL=http://host.docker.internal:3335/mcp/
MAILER_MCP_AUTH_TOKEN=

DOCUMENTS_MCP_PROXY_URL=http://host.docker.internal:3337/mcp/
DOCUMENTS_MCP_AUTH_TOKEN=

ATLASSIAN_MCP_PROXY_URL=http://host.docker.internal:9000/mcp
ATLASSIAN_MCP_AUTH_TOKEN=
```

`ATLASSIAN_MCP_AUTH_TOKEN` is kept as the manager-side MCP key for clients or a
future auth proxy. The upstream `mcp-atlassian` HTTP server uses Atlassian
credentials from `agent-atlassian/.env`; do not put Confluence/Jira secrets in
the manager `.env`.

Workspace-scoped tokens live in each `workspaces/<name>/.env`. The examples
below show the keys that `./wiki-workspace config` creates for local internal
calls:

```env
WIKI_MCP_AUTH_TOKEN=
CME_MCP_AUTH_TOKEN=
PRODUCTION_MCP_AUTH_TOKEN=
```

The workspace chat UI is preconfigured with the correct proxy URLs and bearer
tokens for local calls. For an external Claude Code MCP client on the same
machine, set the bearer in `.mcp.json` to match the generated workspace token.

---

## Git scope

`llm-wiki-manager` is intended to be its own repository. It tracks orchestration
files only. `workspaces/*/` is gitignored.

## License

Released under the **PolyForm Noncommercial License 1.0.0**. See [LICENSE](LICENSE).
