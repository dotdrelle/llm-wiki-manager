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
wiki-workspace agents up          # start cme, documents, mailer (packaged compose)
wiki-workspace agents status      # ✅ each agent should report healthy
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

The active workspace (`/use <workspace>`) is injected automatically on every CME
call — you never pass `workspace` explicitly.

**1. Always start with a status check.** `configured` → proceed; `not_configured`
→ run setup first.

```text
/mcp call cme cme_status
```

**2. First-run setup (once per workspace).** Set `verify_ssl` to `false` for
self-signed / internal certificates. `cme_setup` is idempotent — call it again to
update a credential.

```text
/mcp call cme cme_setup {"base_url":"http://confluence.example.com","username":"user@example.com","pat":"<personal_access_token>","verify_ssl":false}
```

**3. Manage export sources.**

```text
/mcp call cme cme_sources_list
/mcp call cme cme_source_add {"name":"team-space","type":"space","base_url":"http://confluence.example.com","space":"KEY"}
/mcp call cme cme_source_add {"name":"one-page","type":"page","url":"http://confluence.example.com/display/KEY/Title"}
/mcp call cme cme_source_remove {"name":"team-space"}
```

**4. Run exports (asynchronous — poll the job).**

```text
/mcp call cme cme_export_run
/mcp call cme cme_export_status {"job_id":"<job_id>"}
```

> You can do all of the above in plain language too, e.g. *"Configure Confluence
> for this workspace with base URL … and token …, add the space KEY as a source,
> then export it."* The orchestrator maps your request to the CME tools above.

Rules of thumb: never skip `cme_status` at the start of a CME session, never
hard-code credentials (always pass them via `cme_setup`), and remember the active
workspace is injected for you.

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

### Mailer — send-only e-mail

The `mailer` agent sends deliverables by e-mail via MailerSend. Its credentials
live in the manager `.env` (e.g. `MAILERSEND_API_KEY` and the matching auth
token referenced in `mcp.endpoints.json`); no per-workspace setup is required.
Trigger it from chat (*"e-mail this deliverable to …"*) or via `/mcp call`.

### Endpoints & tokens recap

Each external agent has an entry in `mcp.endpoints.json` with a URL and a
`Bearer ${TOKEN}` header; set the matching token variables in `.env`. Workspace-
native servers (`llm-wiki`, `production`) stay configured through each workspace
`.env` instead. See the **External MCP endpoints** and **Starting external
agents** sections in the [main README](../README.md#external-mcp-endpoints) for
the underlying configuration files.
