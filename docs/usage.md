# Ways to use wikiLLM & agent configuration

This page covers the **four ways to drive** wikiLLM and how to **configure the
shared external agents** (Confluence export with CME, document conversion, mail).
For the first-run happy path, see the **Quick start** in the
[main README](../README.md#quick-start--your-first-wiki-in-5-minutes).

---

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

For executable workspace skills, scripting mode uses the same persistent
runtime as the Shell and the web interface:

```bash
wiki-manager --headless --workspace my-project --skill pipeline
wiki-manager --headless --workspace my-project --skill wiki-sync
```

Each shipped skill produces one runtime run: `pipeline` because the production
capability owns its internal DAG, `wiki-sync` because it only exports Confluence
into `raw/untracked/`. A sequential chain appears only for a user-authored
multi-step body; headless then waits for every item carrying the returned
`chainId`, returns non-zero if one fails, and reports a pending approval
immediately rather than waiting for the general timeout. Use `--auto-approve` only for an explicitly
trusted unattended workflow.

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

---

## Configuring the external agents

External agents are **workspace-agnostic** and shared by every project. You start
them once, then point each workspace's credentials at them. Their network
endpoints are declared in `mcp.endpoints.json` (created from
`mcp.endpoints.example.json`), and their tokens live in `.env`.

### Start and verify the agents

```bash
wiki-workspace agents up          # start the packaged external agents
wiki-workspace agents status      # ✅ each agent should report healthy
```

One command starts the whole deployment — agent-runtime, agents and every
configured workspace — and is safe to repeat while things are already up:

```bash
wiki-workspace start              # runtime + agents + all workspaces
wiki-workspace start --open       # …and open the first workspace chat
```

From the `donna` shell you can confirm the same from the orchestrator's side:

```text
/mcp endpoints     # the declared external agents and their URLs
/mcp status        # which endpoints are actually connected
/mcp tools cme     # the tools a given agent exposes
```

### CME — Confluence → Markdown export

CME exports Confluence spaces and pages into Markdown for ingestion. Credentials,
sources, and output are **isolated per workspace**:

```text
.agents-data/cme/<workspace>/cme/app_data.json     # Confluence credentials
.agents-data/cme/<workspace>/sources-manifest.yaml # export sources
workspaces/<workspace>/raw/untracked/               # exported Markdown
```

Configure and use CME through Donna in Agent mode. For example: *"Configure
Confluence for this workspace with this base URL and token, add space KEY, then
export it."* Donna selects the appropriate tools and sends exports through the
orchestrated workflow. The active workspace is applied automatically; never put
the workspace name or credentials in a command line.

### Documents — files → Markdown

The `documents` agent converts PDFs, Office files, text and images into Markdown.
Drive it from the shell:

```text
/upload /path/to/report.pdf      # stage a local file for conversion
/uploads                         # list staged files
/upload convert pending          # convert everything pending
/uploads clean --older-than 30d  # housekeeping
```

Originals are stored under `.agents-data/documents/input/<workspace>/`; converted
Markdown lands in `<workspace>/raw/untracked/`. Images, scanned PDFs, and images
embedded in PDF/Office documents are sent through LLM OCR automatically. If the
agent is down, uploads stay staged and can be converted later.

### Endpoints & tokens recap

Each external agent has an entry in `mcp.endpoints.json` with a URL and a
`Bearer ${TOKEN}` header; set the matching token variables in `.env`. Workspace-
native servers (`llm-wiki`, `production`) stay configured through each workspace
`.env` instead. See the [**External MCP endpoints**](technical-reference.md#external-mcp-endpoints) and [**Starting external agents**](technical-reference.md#starting-external-agents) sections for the underlying configuration files.
