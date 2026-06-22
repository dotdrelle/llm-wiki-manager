# llm-wiki-manager

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

`llm-wiki-manager` is the local cockpit for several `llm-wiki` workspaces. It
creates workspace folders, assigns ports, starts Docker services, exposes MCP
endpoints, and provides the `donna` shell: an agent-first terminal UI that can
inspect workspaces, run safe manager commands, call MCP tools, guide production
jobs, and run one-shot headless tasks.

The manager does not implement the wiki engine or the external agents. It
**orchestrates** them.

---

## What it's for, in one sentence

wikiLLM turns a pile of scattered documents (Confluence pages, files, notes…)
into a **clean, up-to-date wiki**, and can then **regenerate deliverables** from
it (reports, pages, exports). The **manager** is the control deck: it keeps each
project in its own corner, starts the right services, and lets you drive
everything — either with the mouse in a browser, or by talking to an assistant.

A **workspace** = a project. Each project is isolated: its documents, settings,
and results never get mixed up with the others.

## The 4 ways to use it

The same system has four faces depending on what you want to do.

### 1. The web interface — to explore with the mouse

You open a site in your browser and work visually. This is the most accessible
mode, with nothing technical to type. It brings together four facets:

- **Browse the wiki** — read, search, navigate pages. A **graph** visualizes the
  **interdependencies** between pages: at a glance you see which documents rely on
  which others, and the impact of a change.
- **The interface** — buttons, menus, everything is clickable.
- **Chat with an assistant** — an integrated chat that answers about the content,
  but above all an **agent** able to **act**. When a request involves several
  tools (MCP) that depend on each other, it **organizes them into a workflow**:
  it chains the tasks in the right order, waits for one step to finish before
  launching the next, and coordinates everything for you.
- **Plug in tools** — the interface can call external services (Confluence
  export, sending e-mail…) without you having to deal with them.

### 2. Scripting mode — to let it run on its own

The same tool can run **with nobody in front of the screen**: you write the task
as a **script** (one command, or a sequence of commands), launched on demand or
**scheduled** (for example "update the wiki every morning"). Ideal for repetitive,
automated tasks.

### 3. The driver assistant (shell) — to talk in plain language

It's a **shell that works like Claude**: you write your request in plain language,
and the `donna` assistant chains the steps for you. It's the **agentic
orchestrator**: it understands the request, picks the right tools, and acts. Under
the hood it relies on its **internal agentic building blocks** (what it can drive
itself).

### 4. The shared external agents — the common toolbox

Some services live apart and serve **all projects** at once: Confluence export,
sending e-mails, heavy production jobs. You start them once, and they stay
available for any workspace.

## The journey: from first launch to first result

Follow this little story in order. By the end you'll have seen it all: the
interface, the assistant, the tools, and scripting.

**Step 1 — Create your workspace with `wiki-workspace`.**
Everything starts here: `wiki-workspace` creates your project, e.g. `my-project`.
It's the folder that will hold its documents, settings, and results, all on its
own. It ships **pre-filled with an example** (the "basic" scaffold): enough to
have a working use case from the start.

**Step 2 — Configure the MCPs and the environment.**
Fill in the **services (MCP)** and the **environment file**: the keys, URLs, and
tokens the project needs (Confluence, e-mail, production…). It's like plugging in
the cables before switching on.

**Step 3 — Start the shared external agents.**
Start the common toolbox once and for all (Confluence, documents, e-mail,
production). These agents run in the background and serve **all your projects**:

```bash
wiki-workspace agents up        # start cme, documents, mailer…
wiki-workspace agents status    # check they respond
```

**Step 4 — Move to `wiki-manager` or `serve`.**
Two entry doors, your choice:

```bash
wiki-workspace up my-project --open   # open the web interface (serve) in the browser
```

- **`serve`** → the **web interface**: you **browse the wiki** (with its
  **interdependency graph**), click around, and **chat with the built-in
  assistant**.
- **`wiki-manager`** (the `donna` shell) → you **talk in plain language**; it
  **organizes the steps into a workflow** and calls the tools for you.

👉 From this step you already have a concrete result: your wiki is in front of you.
*(If the stack is already running, `wiki-workspace wiki my-project serve --open`
just reopens the web page.)*

**Step 5 — Discover the shipped use case via the `wiki-manager` commands.**
The scaffold ships **ready-to-use examples**. In the shell, explore them:

```text
/skills              list the bundled examples (diagnose, pipeline, status, wiki-sync…)
/skills show <name>  see what an example does
/skills run <name>   run it to see the result
```

It's the best way to **discover every facet** without building anything yourself:
you start from a working case, then adapt it.

**Step 6 — Let it run on its own (optional).**
Once comfortable, turn a task into a **script** and **schedule it** (e.g. every
morning) — that's **scripting mode**. No need to think about it anymore.

## Understanding a project's structure

A workspace keeps everything in five folders. The easiest way is to see them as a
**production line**, from raw materials to finished product:

| Folder | Role | Image |
| --- | --- | --- |
| `raw/` | The **raw sources** you provide (Confluence exports, converted docs). They land in `raw/untracked/`, then are archived into `raw/ingested/` once processed. | Raw material |
| `wiki/` | The **knowledge base**: clean markdown pages, linked together, created and kept up to date from the sources. The consultable core. | The organized warehouse |
| `templates/` | The **deliverable templates**: the shape of the final document, with slots to fill. | The mold |
| `build-context/` | The **rules and references** guiding generation: style, citation rules, expected structure, quality checks. | The build instructions |
| `deliverables/` | The **final deliverables** generated from the `templates`, fed by the `wiki` and the `build-context`. | The finished product |

In one sentence: you **ingest** the sources into the **wiki**, then **generate**
the **deliverables** by filling the **templates** with wiki content, according to
the rules in the **build-context**.

## How a deliverable is generated

The process always follows the same chain. Two entry points depending on your
starting source.

Everything is driven **in plain language** (the web interface chat or the `donna`
shell), or by running a ready-made **skill**. No command line needed.

### Entry point A — from a wiki / Confluence export

At each step, either you **ask for it in plain language**, or you **run the skill**.

1. **Export** Confluence (via the CME agent) → the markdown lands in
   `raw/untracked/`.
   → *"Export the KEY Confluence space into my-project"*
2. **Ingest** — the sources become clean pages in `wiki/` (the originals are
   archived in `raw/ingested/`).
   → *"Ingest the project's sources"*
3. **Index** — builds the search index so the AI finds the right passage.
   → *"Update the index"*
4. **Build** — fills the `templates/` with the wiki + the `build-context/` → the
   `deliverables/`.
   → *"Generate the deliverables"*
5. **Export / polish** — expands citations into their source and refines the
   rendering.
   → *"Export and polish the deliverables"*

> 💡 Even simpler: `/skills run wiki-sync` chains export + ingestion, and
> `/skills run pipeline` runs the whole chain end to end.

### Entry point B — from a simple PDF (the fastest)

Ingestion only reads **markdown**. For a PDF (or a Word file, HTML…), the
**documents agent** does the conversion (it even reads scanned PDFs thanks to OCR,
in French and English). Two ways to hand it the file:

- **Simplest — via chat**: drag/attach the PDF directly into the conversation and
  ask *"Convert this PDF into my-project"*. The agent turns it into markdown and
  **drops it into `raw/untracked/` by itself**.
- **Via folder**: put the PDF in the documents agent's input folder
  (`.agents-data/documents/input/`), then ask *"Convert the file my-doc.pdf into
  my-project"*.

Then it's the **same path** as entry point A: ingest → index → build → export. The
shortest route for a first try: hand over a PDF, then `/skills run pipeline`.

### Exploring the example data

The scaffold ships with a working case. To discover it, in the chat or the `donna`
shell:

```text
/skills                 list the examples (diagnose, pipeline, status, wiki-sync)
/skills show pipeline   show what the end-to-end example does
/skills run pipeline    run the full chain on the example sources
/wiki                   inspect the project's wiki
```

You can also simply **open the folders** `raw/`, `wiki/`, `templates/`, and
`deliverables/` of the workspace to see, at each step, what goes in and what comes
out.

> ⚙️ *Advanced (later)*: the same steps exist on the command line via
> `wiki-workspace wiki …` (`doctor`, `ingest`, `build`, `logs`). Keep these for
> automation and debugging — for everyday use, stay in the chat or the skills.

## In short

| You want to… | You use… |
| --- | --- |
| Explore and click | The **web interface** (`up … --open`) |
| Let it run on its own | **Scripting mode** (script + scheduler) |
| Talk in plain language | The **`donna` assistant** (shell, agentic) |
| The shared services | The **external agents** (Confluence, e-mail, production) |

The right reflex to get started: **steps 1 → 4**, and your wiki is already in front
of you in the browser (create → configure → start the agents → open).

---

# Technical reference

## Toolchain

| Repository | Role |
| --- | --- |
| [`llm-wiki`](https://github.com/dotdrelle/llm-wiki) | Workspace engine: CLI, web UI, MCP server, retrieval, deliverables, skills |
| [`llm-wiki-manager`](https://github.com/dotdrelle/llm-wiki-manager) | Multi-workspace cockpit, Docker orchestration, `donna` shell |
| [`agent-cme`](https://github.com/dotdrelle/agent-cme) | Global Confluence to Markdown MCP exporter; workspace injected automatically by Donna |
| [`agent-wiki-production`](https://github.com/dotdrelle/agent-wiki-production) | Workspace-scoped production jobs: ingest, build, export, polish, pipeline |
| [`agent-wiki-documents`](https://github.com/dotdrelle/agent-wiki-documents) | Document conversion MCP: PDF/Office/HTML/images → Markdown (OCR-capable) |
| [`agent-mailer-api`](https://github.com/dotdrelle/agent-mailer-api) | Optional external mailer MCP endpoint |

## Workspace Model

Each managed workspace is a normal `llm-wiki` workspace plus manager metadata:

```text
workspaces/<name>/
  .env                 # ports, tokens, workspace path
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
```

When installed through `npm`/`npx`/`bun`, `wiki-manager` keeps its state outside
the package, in the directory where the command is launched:

```text
./workspaces/            # workspace registry
./.env                   # local configuration (gitignored; copy from .env.example)
./mcp.endpoints.json     # external MCP endpoints (gitignored; copy from .env.example)
```

`WIKI_WORKSPACES_DIR` is available as an explicit override for the workspaces
directory, but not required for normal usage.

### Local `.env`

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

The `.env` file is loaded automatically by both `wiki-manager` (Node/Bun process)
and `wiki-workspace` (Docker Compose). It sets `WORKSPACES_ROOT`, per-agent auth
tokens, mailer credentials, and optional port overrides.

### External MCP endpoints

`mcp.endpoints.json` declares external agents for the shell, TUI, headless, and
the served chat UI. Values support `${VAR}` interpolation resolved from the
process environment (including the `.env` loaded at startup):

```json
{
  "mcpServers": {
    "cme": {
      "url": "http://host.docker.internal:${CME_MCP_PORT:-3336}/mcp/",
      "headers": { "Authorization": "Bearer ${CME_MCP_AUTH_TOKEN}" }
    },
    "documents": {
      "url": "http://host.docker.internal:${DOCUMENTS_MCP_PORT:-3337}/mcp/",
      "headers": { "Authorization": "Bearer ${DOCUMENTS_MCP_AUTH_TOKEN}" }
    }
  }
}
```

Copy `mcp.endpoints.example.json` to `mcp.endpoints.json` and set the matching
token variables in `.env`.

### Starting external agents

Start CME, documents, and mailer once for all workspaces:

```bash
wiki-workspace agents up
```

This uses the packaged `agents.docker-compose.yml`. `WORKSPACES_ROOT` is resolved
automatically from the manager workspaces directory. Agent state is stored under
`./.agents-data/` unless `AGENTS_DATA_DIR` is set.

Workspace-native MCP servers (`llm-wiki`, `production`) stay configured through
each workspace `.env`. External agents are workspace-agnostic: the active
`/use <workspace>` is injected automatically on every CME and documents tool
call — no need to pass `workspace` explicitly.

CME data is isolated per workspace:

```text
.agents-data/cme/<workspace>/cme/app_data.json     # Confluence credentials
.agents-data/cme/<workspace>/sources-manifest.yaml # export sources
workspaces/<workspace>/raw/untracked/               # exported Markdown
```

Create a workspace:

```bash
wiki-workspace config my-project [path]
```

Start it:

```bash
wiki-workspace up my-project
```

Run wiki commands:

```bash
wiki-workspace wiki my-project doctor
wiki-workspace wiki my-project ingest
wiki-workspace wiki my-project build --plan
wiki-workspace wiki my-project build
```

## Services

The shared `docker-compose.yml` starts one workspace stack:

| Service | Role | Port variable |
| --- | --- | --- |
| `serve` | Wiki web UI and browser chat | `WIKI_SERVE_PORT` |
| `mcp-http` | llm-wiki MCP endpoint | `WIKI_MCP_PORT` |
| `production-mcp` | Production job MCP endpoint | `PRODUCTION_MCP_PORT` |

Use `wiki-workspace` whenever possible so Compose receives the right project
name, env file, ports, and volume mounts.

```bash
wiki-workspace list
wiki-workspace agents up
wiki-workspace agents status
wiki-workspace up my-project
wiki-workspace wiki my-project logs
```

### Document uploads

The shell can deposit local documents into the documents agent input volume and
convert them when the `documents` MCP endpoint is connected:

```bash
/upload /path/to/rapport.pdf
/uploads
/upload convert pending
/uploads clean --older-than 30d
```

Original files are stored under
`.agents-data/documents/input/<workspace>/`. Converted Markdown is written by
the documents agent to `<workspace>/raw/untracked/`. If the documents agent is
down, the upload remains stored and can be converted later.
Image files, scanned PDFs, and images detected inside PDF or Office documents
are sent through LLM OCR automatically.

## The `donna` Shell

Start the agent shell:

```bash
bun start          # full OpenTUI shell (requires Bun ≥ 1.2)
pnpm start         # alias for bun start
pnpm run start:node  # fallback: legacy repl.js shell under Node
```

The interactive shell is agentic by default:

- input starting with `/` runs a deterministic shell primitive;
- by default, any other input goes to the LangGraph orchestrator with MCP tools;
- `/chat` switches free text to direct LLM chat without tools;
- `/agent` switches free text back to the LangGraph orchestrator;
- the visible agent name is `donna`;
- conversation history is separated per workspace;
- Ctrl+C interrupts active LLM/MCP calls; Ctrl+C twice exits when idle.

Direct chat requires an active workspace config with `llm.apiKey`, `llm.model`,
and `llm.baseUrl`. If those are missing, the shell reports the missing fields
and points to `/use`, `/config list`, `/config use`, or `/config edit`.

The TUI uses a two-pane layout:

- **Left** — scrollable conversation thread with a chat input at the bottom.
  Typing `/` opens a slash-command completion overlay just above the input.
  Mouse wheel scrolls the conversation, and selecting text copies it through the
  TUI clipboard bridge. Message headers also expose a `[ copy ]` target for
  copying one message. PageUp/PageDown remain available for keyboard scrolling.
- **Right** — Plan/Queue tabs, active MCP jobs, plus a live log/trace panel.
  `Ctrl+Q` toggles the tabs; clicking `Plan` or `Queue (N)` selects that tab
  directly. MCP connection details remain available through `/mcp status`.

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
/queue
/queue cancel <id>
/queue clear
/wiki
/wiki run <args...>
/skills
/skills show <name>
/skills run <name>
/chat
/agent
/clear
```

Skills are loaded only from the active workspace. The manager itself has no root
`SKILL.md` and no root `skills/` directory.

Workspace switching is isolated. When you run `/use my-project`, the shell
switches both the displayed conversation and the LLM history to `my-project`.
Returning to another workspace restores that workspace's in-memory conversation
for the current shell process.

## Agent Tooling

The `donna` agent uses a LangGraph (`@langchain/langgraph`) ReAct loop (max 80
tool-use iterations). The LLM client is the `openai` SDK against any
OpenAI-compatible endpoint. Each agent turn makes a single streaming LLM call via
Server-Sent Events. Text tokens appear in the TUI as they arrive. When the LLM decides to call tools, the stream
switches to tool-call accumulation; tool results feed back into the next LLM call
until the agent produces a final text response.

The LLM can call:

- **connected MCP tools** — discovered at `/use` time and re-discovered on
  `/mcp status`, `/start`, and `/stop`;
- **`shell__run_command`** — restricted internal tool for safe manager primitives
  only.

For actionable requests, the orchestrator must not answer with future intent only.
If a connected MCP tool or safe primitive can perform the action, it must call the
tool in the same turn. If required arguments are missing, ask for the exact
missing values. If the tool/server is unavailable, name the concrete blocker.

`shell__run_command` is limited to safe manager primitives and does not expose
arbitrary system commands, `/mcp call`, `/wiki run`, `/start`, `/stop`, `/logs`,
or `/exit`.

### Tool naming

LLM-facing tool names use `<server>__<tool>`. For the llm-wiki MCP server this
means remote tools are intentionally named with both the server namespace and the
canonical llm-wiki tool name:

```text
wiki__wiki_list_pages
wiki__wiki_read_page
wiki__wiki_collect_context
```

The only internal manager tools under the `wiki__*` namespace are `wiki__plan_set`
and `wiki__plan_done`. All other `wiki__*` calls are routed to the remote `wiki`
MCP endpoint.

### Production job queue

`production_start_job` remains protected by the production MCP workspace lock.
When a production job is already active, or when the production MCP returns
`workspace_busy`, the manager stores the new request in an in-memory local queue
instead of dropping it.

The queue is intentionally narrow in this version: only `production_start_job` is
queueable; the production MCP lock remains the source of truth; queue items are
scoped to the workspace that created them; switching workspaces freezes queued
items from the previous workspace until you switch back.

Use the Queue tab in the right pane, or `/queue`, `/queue cancel <id>`, and
`/queue clear`. `/queue cancel <id>` removes waiting/starting items locally; for a
running production queue item, it calls `production_cancel_job(jobId)`.

## Non-Interactive Mode

The `--once` mode runs one agent turn:

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

Headless mode creates a normal session, runs `/use`, and writes a log under
`.wiki/logs/` by default. `--prompt` runs one agent turn unless `--wait` is passed.
`--skill` uses the agentic loop by default: agent turn, wait for active MCP jobs
declared through `_activity.poll`, then re-invoke the agent with the completed job
summary so it can start the next required step.

Useful headless controls:

```bash
node ./bin/wiki-manager.js --headless --workspace my-project --skill pipeline --timeout 3600 --max-turns 20
node ./bin/wiki-manager.js --headless --workspace my-project --skill pipeline --no-wait
node ./bin/wiki-manager.js --headless --workspace my-project --prompt "check production status" --wait
```

`--timeout` applies per wave of active jobs, not to the whole run. `--max-turns`
limits the number of LLM turns in a skill run. The process exits non-zero on
failed/cancelled activities, activity timeout, max-turn exhaustion, or setup
failure. Use `--log-file <path>` to choose a specific log path.

## MCP Activity Contract

The manager is MCP-agnostic for job tracking. Any MCP response can opt into
automatic shell/headless monitoring by including `_activity`:

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

The existing native payload should stay intact. `_activity` is additive metadata
for the manager. When `poll` is present, the shell/TUI and headless loop call the
declared MCP tool until the activity becomes terminal.

## Local Compose Overrides

Do not put machine-specific settings in the shared `docker-compose.yml`.

For example, if a VPN/proxy requires a custom CA bundle, create a local ignored
override such as `docker-compose.ca.local.yml` and run:

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
- `.env` quoted values support basic escapes such as `\"`, `\\`, `\n`, `\r`, and
  `\t`.

## Development

```bash
pnpm install
pnpm start
pnpm run check
```

When bumping the package version, update both `package.json` and the Streamable
HTTP MCP `clientInfo.version` in `src/core/mcp.js`. They are kept explicit so
remote MCP server logs show the manager build that initiated the handshake.

`pnpm run check` verifies the CLI version, help output, and limited `--once` mode.
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
│   ├── agent/              # agentic orchestration: @langchain/langgraph (ReAct loop) + openai SDK (OpenAI-compatible LLM client, SSE streaming)
│   ├── cli/                # CLI entrypoint
│   ├── commands/           # slash commands
│   ├── core/               # compose, env, MCP, activity, agentEvents, plan, skills, workspace registry
│   └── shell/
│       ├── repl.js         # legacy TUI and pipe shell (Node fallback)
│       ├── tui.tsx         # OpenTUI shell root (Bun)
│       ├── LeftPane.tsx    # conversation view + chat input
│       ├── RightPane.tsx   # plan, activity, and log panel
│       ├── SlashDialog.tsx # completion overlay
│       ├── useSession.ts   # reactive session state
│       ├── useAgent.ts     # agent call wrapper (drives the @langchain/langgraph run)
│       └── renderer.ts     # markdown stripping and line coloring
├── docker-compose.yml      # workspace-scoped stack (serve, mcp-http, production-mcp)
├── agents.docker-compose.yml  # global external agents (cme, documents, mailer)
├── wiki-workspace
├── .env.example            # template for local .env (WORKSPACES_ROOT, agent tokens, …)
├── mcp.endpoints.example.json
└── workspaces/.env.example
```

## License

Released under the PolyForm Noncommercial License 1.0.0. See [`LICENSE`](LICENSE).
