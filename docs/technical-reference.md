# Technical reference

> Moved out of `README.md`, which is the npm landing page: it must answer "what
> is this and how do I start it" in one screen. Everything that answers "how does
> it work internally" lives here, on git, where it can be as long as it needs to
> be. See also [`configuration.md`](configuration.md) for every key and
> [`usage.md`](usage.md) for the four ways to run wikiLLM.


## Toolchain

| Repository | Role |
| --- | --- |
| [`llm-wiki`](https://github.com/dotdrelle/llm-wiki) | Workspace engine: CLI, web UI, MCP server, retrieval, deliverables, skills |
| [`llm-wiki-manager`](https://github.com/dotdrelle/llm-wiki-manager) | Multi-workspace cockpit, Docker orchestration, `donna` shell |
| [`agent-cme`](https://github.com/dotdrelle/agent-cme) | Global Confluence to Markdown MCP exporter; workspace injected automatically by Donna |
| [`agent-production`](https://github.com/dotdrelle/agent-production) | Workspace-scoped production jobs: ingest, build, export, polish, pipeline |
| [`agent-documents`](https://github.com/dotdrelle/agent-documents) | Document conversion MCP: PDF/Office/HTML/images → Markdown (OCR-capable) |

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

## Configuration overview

wikiLLM is configured by **four files** held together by two families of keys:
**MCP keys** (Bearer tokens that authenticate *who connects to whom*) and **LLM
keys** (`apiKey` + `baseUrl` that *reach a model*).

![wikiLLM configuration keys — MCP vs LLM, where each key is configured](https://raw.githubusercontent.com/dotdrelle/llm-wiki-manager/main/docs/config-keys.png)

<sub>Source: [`config-keys.svg`](config-keys.svg) — edit the SVG, regenerate the PNG.</sub>

| File | Owner | Scope | Holds |
| --- | --- | --- | --- |
| `.env` | manager | global | shared secrets: agent MCP tokens, OCR LLM, port overrides, variables for any user-declared external MCP |
| `mcp.endpoints.json` | manager | global | where each external agent lives + which `Bearer`/header to send |
| `workspaces/<name>/.env` | manager | per workspace | ports, workspace path, the wiki's own MCP tokens |
| `workspaces/<name>/.wikirc.yaml` (+ `.wikirc.yaml.<profile>`) | workspace | per workspace | LLM & vector keys (provider/model/apiKey/baseUrl/retrieval) |

Donna reaches the external agents and the internal wiki MCP through Bearer
tokens; the wiki then uses its `.wikirc.yaml` LLM keys to call models and
embeddings. Because every MCP server is an HTTP endpoint, remote MCP clients can
connect to the same surfaces with the same tokens. **MCP keys** are set in the
root `.env`; the wiki's **LLM keys** live in each workspace `.wikirc.yaml`.

See the full, field-by-field reference in
**[docs/configuration.md](configuration.md)**.

## Installing from source

```bash
corepack enable
pnpm install
```

Whether installed locally, globally, or from source, `wiki-manager` keeps its
state outside the package, in the directory where the command is launched:

```text
./workspaces/            # workspace registry
./.env                   # local configuration (gitignored; copy from .env.example)
./mcp.endpoints.json     # external MCP endpoints (gitignored; copy from .env.example)
```

`WIKI_WORKSPACES_DIR` is available as an explicit override for the workspaces
directory, but not required for normal usage.

`WIKI_MANAGER_ENDPOINTS_FILE` can override the default
`./mcp.endpoints.json`. Compose templates remain in the installed package, while
relative volumes and runtime state are resolved from the directory where
`wiki-workspace` is launched.

### Local `.env`

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

The `.env` file is loaded automatically by both `wiki-manager` (Node/Bun process)
and `wiki-workspace` (Docker Compose). It sets `WORKSPACES_ROOT`, per-agent auth
tokens, optional port overrides, and credentials for enabled connectors.

### External MCP endpoints

`mcp.endpoints.json` declares external agents for the shell, TUI, headless, and
the served chat UI. Values support `${VAR}` interpolation resolved from the
process environment (including the `.env` loaded at startup):

```json
{
  "mcpServers": {
    "cme": {
      "url": "http://host.docker.internal:${CME_MCP_PORT:-3336}/mcp/",
      "headers": { "Authorization": "Bearer ${CME_MCP_AUTH_TOKEN}" },
      "requireApproval": ["cme_export_run"],
      "retry": { "maxAttempts": 2, "backoffMs": 500 },
      "toolRetries": {
        "cme_export_run": { "maxAttempts": 3, "backoffMs": 1000 }
      }
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

### `chatAccess`: which tools chat may use

Declaring a server above makes its tools available to **`/agent`** — no further
declaration, ever. Plug in a new MCP and Donna discovers and uses its tools
immediately.

The optional `chatAccess` block is the authorization layer for **`/chat`**,
which is closed by default. It decides which tools chat may use, and nothing
else:

```json
"chatAccess": {
  "maxToolIterations": 8,
  "servers": {
    "cme":  { "allow": ["cme_status", "cme_sources_list", "cme_export_status"] },
    "exa":  { "allow": ["*"] }
  }
}
```

| entry | effect in `/chat` |
| --- | --- |
| server absent | none of its tools — agent-only |
| `"allow": ["*"]` | every tool the server exposes |
| `"allow": [names]` | exactly those tools |

Every server uses this one shape. The list is authoritative: naming a tool is
the decision, whatever the tool is called. No name heuristic filters it — a
tool name is not a contract, and a third-party MCP is free to name its tools
however it likes.

`/chat` carries no plan: it performs direct unitary actions only. The
orchestration entry points (`agent_plan`, `agent_execute`,
`production_start_job`, and plan mutation) are therefore never offered to it,
including under `"*"`. Multi-step work belongs to `/agent`.

An `allowActions` key written by an older manager is folded into `allow` on
read and removed on the next `agents up`.

`chatAccess` is not how workspace context reaches chat. The workspace profile
(`.wiki/profile.md`) is read from disk and injected into the system prompt of
both modes, so durable preferences — tone, formatting, notification recipient —
shape every reply without a tool call and without an allow-list entry. Adding
`profile_read` here would help no existing install anyway: the scaffold's
additive merge only fills missing top-level keys and never edits an allow-list
you already have.

### Adding a connector from the served chat UI

`mcp.endpoints.json` stays hand-editable, but the Connectors panel of
`llm-wiki serve` can now write it. Connecting a card there upserts the endpoint
through the runtime (`POST /mcp/endpoints`), and the runtime immediately
re-reads the file and rediscovers tools and agents — no restart, and the new
tools are usable in the same breath by `/chat`, `/agent` and any subsequent
plan.

Because a server absent from `chatAccess` gets **zero** tools in `/chat`, the
upsert writes `"allow": "*"` for it. That is the deliberate difference between
a connector declared by hand — where you choose the tool list — and one added
from the UI, where the person adding it is the person who will use it. Narrow
it afterwards by editing the file.

Three origins are distinguished, and the UI labels each card:

| origin | shown as | who owns it |
| --- | --- | --- |
| `wiki`, `production`, `llm-wiki`, `wiki-production` | `internal` | the workspace stack. Fields read-only, no delete — the runtime rejects any change to these names |
| declared in `mcp.endpoints.json` by hand or by `agents up` | `global config` | the operator. CME, Documents, Mailer, Connectors, Exa… |
| added from the UI | `added here` | carries `"managedBy": "serve-ui"` in the file |

Removing a `global config` connector is a workspace-wide act — it leaves every
chat, agent and future plan — so the UI says so before confirming. The
container and its data are untouched; only the wiring is removed. The name is
also pushed into `disabledMcpServers`, which the scaffold honours, so a
connector you removed on purpose is not silently restored by the next
`agents up` merging the packaged example back in.

Renaming is atomic: the UI sends `previousName`, and the endpoint, its
`Authorization` header and its `chatAccess` entry move together under the new
key. A rename onto an existing name, or from a name that is not there, is
rejected rather than half-applied.

`POST /mcp/endpoints` returns **409 while a plan is running** — connector
wiring must not change under a run that already resolved its agents. The chat
UI treats that as what it is: the MCP handshake succeeded, so the card stays
connected and usable in this browser, badged `local only` with
"runtime synchronization pending", and the write is retried on the next
reconnect. A busy runtime never presents itself as a broken connector.

MCP `tools/call` requests retry transient HTTP/MCP failures before the run fails.
They also share a per-endpoint outbound control budget (45 RPM by default,
configurable with `WIKI_MANAGER_MCP_REQUESTS_PER_MINUTE`). This budget is
independent from `.wikirc` `requestsPerMinute`, which remains reserved for LLM,
embedding, and reranking provider calls.
Set global defaults with `WIKI_MANAGER_MCP_RETRY_MAX_ATTEMPTS` and
`WIKI_MANAGER_MCP_RETRY_BACKOFF_MS`, or override them per endpoint with `retry`
and per tool with `toolRetries`.

After a clean runtime run, the manager runs a lightweight evaluator pass against
the original task, final plan, recent activities, and recent conversation. The
verdict is emitted as `run_evaluated` and appears in runtime state as
`evaluation`. Disable it globally with `WIKI_MANAGER_EVALUATOR=0`, or per run by
posting `/run` with `"evaluate": false`.

When evaluation fails, or when a watched activity ends in error, the runtime can
ask the LLM for a partial recovery plan and continue only the remaining steps.
Each recovery is emitted as `run_replanned` and appears in runtime state as
`replans`. Limit attempts with `WIKI_MANAGER_REPLANNER_MAX_REPLANS` or per run
with `"replans": 1` in the `/run` body.

Runtime approvals are bounded to a run, plan revision and approval class.
Mutating orchestrated tasks **wait for approval by default**, including tasks
created by a skill or a directly selected capability such as ingest or
pipeline. Approve them by running `/approve`, or clicking Approve in either UI:
the Shell right-pane banner, or the `serve` banner.

In `serve` that banner is a **fixed overlay, visible in every centre view**. It
used to sit inside the composer, which the layout hides in the wiki, connectors
and execution views — so a restore launched from `/history` waited on an
approval nobody could see, and the Execution view, the one meant for monitoring,
could not show it either. The Shell never had that gap because its plan pane is
always on screen. `POST /approve` also accepts an explicit run scope.

An explicitly launched skill is also approval-gated. For an orchestrated skill,
the scheduler blocks each uncovered mutating task; for a `direct` skill, the
run-level gate blocks its first direct mutation. Declaring `execution: direct`
changes routing and available tools—it does not grant automatic approval.

External direct MCP tools may additionally declare a per-tool `requireApproval`
policy. Their pending entries can be approved with
`POST /approve?itemId=...` or `/approve item <id>`. The timeout defaults to ten
minutes and can be changed with `WIKI_MANAGER_APPROVAL_TIMEOUT_MS` or
`approvalTimeoutMs` in the `/run` body. Auto-approval is never inferred from a
skill or an interactive UI: it requires the caller to pass
`autoApprove: true`, intended for headless/CI (`--auto-approve`).

### Parallelism & throughput

The number of tasks that run at once is `MIN(agent recommendedConcurrency, agent
maxConcurrency, WIKI_MANAGER_CAPABILITY_CONCURRENCY, per-task limits)` — a
minimum, so the manager ceiling can only lower it. The production agent ships
intermediate defaults (`PRODUCTION_RECOMMENDED_CONCURRENCY=4` /
`PRODUCTION_MAX_CONCURRENCY=8`, ≈ 4 parallel); locks then cap real parallelism
per phase (`ingest_apply` stays serial). The resolved value is shown in both
UIs' run summary and on the run node of the execution graph, with an amber
"(ceiling)" marker when the manager ceiling binds. Low/high profiles, the lock
model and the LLM-backend caveat are in
[configuration.md § "Parallelism & throughput"](configuration.md).

While a run is active, `GET`/`POST /control` still answers without waiting for
it to finish: `{"action":"status"}` returns the current run/plan/queue state,
`{"action":"explain"}` adds a one-line plain-language summary, and
`{"action":"enqueue","input":"..."}` accepts a new request without touching the
active plan. A queued request starts automatically as soon as the workspace
goes idle — either because the enqueue call itself found the workspace free,
or because the run in progress finished and drained the next queued item.

`GET /config/profiles` lists the `.wikirc` profiles for a workspace and
`POST /config/use {"profile":"..."}` switches the active one — the same
switch as the shell's `/config use`, rejected with 409 while a run is active.
The manager is the source of truth for which profile is active; `llm-wiki
serve`'s config-profile picker mirrors whatever the manager reports rather
than tracking its own state.

### Starting external agents

Start CME and documents once for all workspaces:

```bash
wiki-workspace agents up
```

Or start the whole deployment at once — agent-runtime, agents and every
configured workspace, safe to repeat:

```bash
wiki-workspace start [--open]
```

This uses the packaged `agents.docker-compose.yml` (it lives inside the npm
package — never edit it, updates overwrite it). On first run, `agents up`
generates the missing agent auth tokens into your manager `.env` and seeds
`mcp.endpoints.json` from the packaged example. `WORKSPACES_ROOT` is resolved
automatically from the manager workspaces directory. Agent state is stored under
`./.agents-data/` unless `AGENTS_DATA_DIR` is set.

An `npm -g update @dotdrelle/wiki-manager` replaces the packaged Compose files
but preserves the operator-owned `.env`, `mcp.endpoints.json`, workspaces, agent
data, and runtime database. Missing standard endpoint definitions are migrated
additively; existing endpoint definitions are never overwritten.

The Gmail connector agent is packaged but opt-in. Enable it in the manager
`.env`:

```dotenv
CONNECTORS_ENABLED=true
# Optional locally; generated from CONNECTORS_MCP_PORT when empty:
GOOGLE_OAUTH_CALLBACK_URL=
```

For a local installation, `wiki-workspace agents up` fills an empty callback
with:

```text
http://127.0.0.1:<CONNECTORS_MCP_PORT>/oauth/google/callback
```

With the default port, register this exact redirect URI in Google Cloud
Console:

```text
http://127.0.0.1:3338/oauth/google/callback
```

The browser resolves `127.0.0.1`; Docker forwards the published host port to
the connectors container. For a remote deployment, set an explicit public
HTTPS callback instead. In both cases the configured URL must match the Google
Cloud redirect URI exactly.

The local flow uses the public wikiLLM Desktop OAuth Client ID with PKCE and
does not require a Client Secret. Normal users set neither Google credential.
`GOOGLE_OAUTH_CLIENT_ID` remains an advanced override for private/internal
Google projects, and `GOOGLE_OAUTH_CLIENT_SECRET` is an optional compatibility
override for administrators using a confidential web client.

`agents up` also generates the connectors MCP token plus distinct OAuth
start/state secrets when missing. It adds a regular, standard MCP `connectors`
entry to `mcp.endpoints.json`. Setting `CONNECTORS_ENABLED=false` and running
`agents up` removes that entry again, so disabled services are not probed. No
non-standard `enabled` property is written to MCP configuration files.
The matching `chatAccess.connectors` policy is managed at the same time, in the
same shape as every other server — a single `allow` list holding
`connectors_google_status` and `connectors_google_oauth_start`, so chat can
report the authorization state and start it. See
[`chatAccess`](#chataccess-which-tools-chat-may-use).

Connector authorization is also available without asking the LLM. These two
commands work in both the Shell UI and the `llm-wiki serve` chat:

```text
/connector list
/connector auth google
```

The first reports the Gmail authorization state for the active workspace. The
second opens Google's OAuth page in the browser. Authorization through the
serve proxy asks for the `read` **and** `send` grants by default; when the
deployment disabled send (`CONNECTORS_SEND_ENABLED=false`), the proxy retries
read-only so the flow never fails because of it. The agent's callback page
links "back to the workspace" at the serve origin. Asking Donna
to configure or check Google remains supported through the direct connector
tools above.

The Compose profile is an internal implementation detail. Do not set
`COMPOSE_PROFILES` and do not add provider names such as Gmail or Slack to it:
one `agent-connectors` service hosts all connector providers.

For a public serve deployment, authorization can be started through the
same-origin proxy:

```bash
curl -X POST https://wiki.example.com/api/connectors/google/oauth/start \
  -H 'Origin: https://wiki.example.com' \
  -H 'X-LLM-WIKI-OAUTH: 1' \
  -H 'Content-Type: application/json' \
  -d '{"instanceId":"google-1"}'
```

Open the returned `authorizationUrl`. The workspace is injected by serve and
cannot be selected by the browser request. Grants default to `read` + `send`;
an explicit `grants` array is forwarded as-is.

Donna discovers the agent contract automatically from the `connectors` MCP
endpoint. With only one provider, no routing entry is required. To pin it
explicitly in a workspace profile:

```yaml
capabilityRouting:
  external-source.collect:
    preferredAgents: [connectors]
    allowedAgents: [connectors]
```

The production agent also advertises `workspace.restore` for Git-backed
rollback. It is workspace-scoped and remains subject to the normal runtime
approval and lock checks; it can be pinned in the same way when several agents
provide that capability.

#### Compose overrides — optional agents, proxies, local fixes

Two override files sit under **`.wiki/compose/`**, one per stack:

| File | Applies to |
| --- | --- |
| `.wiki/compose/docker-compose.override.yml` | workspace stack (`serve`, `mcp-http`, `production-mcp`, `wiki`) |
| `.wiki/compose/agents.docker-compose.override.yml` | agents stack (`cme`, `documents`, `connectors`) |

Both are created for you on first use, from packaged templates full of
ready-to-uncomment examples, and are **never rewritten afterwards** — your edits
survive package updates. Existing root-level files are migrated automatically.
Do not confuse them with `.wiki/runtime/*.compose.yml`,
which the manager regenerates on every Compose command; editing those is always
lost.

Compose merge is standard: new services are added, same-name keys override the
defaults, `environment` merges per variable name. Only extend services the
packaged file declares — an invented service name becomes a phantom service
Compose keeps trying to start.

The most common use behind a VPN is proxy passthrough: containers do not inherit
the host environment, and only `connectors` ships proxy variables by default. See
[`docs/configuration.md`](configuration.md) § "Compose overrides" for a
copy-paste block and the `host.docker.internal` / `NO_PROXY` pitfalls.

The second use is running an external connector alongside the packaged agents.
Complete the setup by
adding the connector's variables to your `.env` and its endpoint block to
your `mcp.endpoints.json` — every variable an external MCP endpoint needs
lives in the `.env` and is referenced as `${VAR_NAME}` from
`mcp.endpoints.json`. A connector running outside the manager Compose stack
only needs an entry in `mcp.endpoints.json`.

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

Start it — or start the whole deployment in one command (agent-runtime, agents
and every configured workspace; safe to repeat):

```bash
wiki-workspace up my-project
wiki-workspace start [--open]
```

Run wiki commands:

```bash
wiki-workspace wiki my-project doctor
wiki-workspace wiki my-project ingest
wiki-workspace wiki my-project build --plan
wiki-workspace wiki my-project build
```

### Resetting a workspace

```bash
wiki-workspace wiki my-project down            # the services must be stopped
wiki-workspace wiki my-project reset --dry-run # what would go, what stays
wiki-workspace wiki my-project reset
```

`reset` empties a workspace while keeping the **method**: `.wikirc*` (provider,
model, retrieval, per-profile variants), `templates/` and `build-context/` —
plus `.env`, which holds the workspace's ports and MCP tokens and without which
nothing could be restarted.
Everything the workspace produced, cached or logged goes — `wiki/`,
`deliverables/`, `raw/untracked/`, `raw/ingested/`, `.wiki/` (vector index,
cache, logs, tmp, build state, skills, profile, system prompt), `CLAUDE.md`,
`.gitignore` — then `wiki init` puts the empty structure back.

Three things worth knowing:

- `.git/` is kept when present, so the state from before the reset stays
  reachable through `wiki restore`. It is the only undo there is.
- The command refuses to run while workspace services are up: a container
  writing into the bind mount would recreate part of what was erased and leave
  files owned by another UID behind.
- It stops there. Nothing is re-synced and nothing is rebuilt — refilling the
  workspace is a decision, not a side effect of emptying it.

It is available **only** here: there is no `wiki reset` CLI subcommand, no
production job type, no MCP tool and no skill for it. Nothing Donna can call
may erase a workspace. Confirmation is interactive (retype the workspace name)
unless you pass `--yes`.

## Services

The shared `docker-compose.yml` starts one workspace stack:

| Service | Role | Port variable |
| --- | --- | --- |
| `serve` | Wiki web UI and browser chat, container port `3000` | `WIKI_SERVE_PORT` |
| `mcp-http` | llm-wiki MCP endpoint, container port `3333` | `WIKI_MCP_PORT` |
| `production-mcp` | Production job MCP endpoint, container port `8080` | `PRODUCTION_MCP_PORT` |

Use `wiki-workspace` whenever possible so Compose receives the right project
name, env file, ports, and volume mounts.

`PRODUCTION_ALLOWED_STEPS` gates what `production-mcp` will accept, and an
omission from it is **silent**: `agent_plan` simply leaves the step's task out of
the fragment instead of failing. `taxonomy` was missing from the shipped default
for several releases, so every compose-deployed ingest ran without the taxonomy
barrier and left the published map stale. Keep the variable in step with the
in-code default of `production_mcp_server.py`: a test here asserts `taxonomy` is
present, and one in `agent-production` compares the whole list against that
in-code reference. Remember that an explicit value in your `.env` overrides the
default entirely.

Runtime split: the host manager/runtime uses Node.js 22+ for `node:sqlite`; the
interactive OpenTUI shell uses Bun 1.2+; workspace Docker services run from the
published images and do not depend on host `node_modules`.

Two consequences worth knowing before debugging anything:

- **The runtime is not a container.** `runtime/lifecycle.js` spawns it locally,
  detached, from the manager sources — no Compose file declares it. Changing
  runtime or shell code therefore needs a **restart**, never an image rebuild;
  changing `llm-wiki` or an agent needs the image rebuilt.
- **The runtime starts before the workspace containers.** Its first agent
  discovery legitimately finds them absent. `agentRegistry` keeps a known
  agent's capabilities when a probe fails — it only refreshes `lastSeenAt`, and
  says so in the runtime log — and the periodic re-scan re-probes the MCP
  endpoints instead of reusing a cached status. Without both, a capability the
  agent really has stayed missing from the registry until the next successful
  discovery, and the only symptom was a run failing much later with
  `No agent provides capability …`.

As of 0.11.4, the host runtime store carries a minimal format guard:
`PRAGMA user_version = 1` in SQLite plus `.wiki/meta.json` with
`schemaVersion: 1`. Unknown future versions stop startup with a clear error.
On startup, terminal runs older than 30 days are deleted with their events and
the database is vacuumed. The runtime test suite also includes a fixed-latency
parallel scheduler guard asserting that two independent build tasks run under
65% of the sequential duration.

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
are sent through LLM OCR automatically. The bundled agent stack defaults to
the Albert-compatible endpoint and
[`lightonai/LightOnOCR-2-1B`](https://huggingface.co/lightonai/LightOnOCR-2-1B);
configure it with `DOCUMENT_LLM_BASE_URL`, `DOCUMENT_LLM_MODEL`, and the
dedicated `DOCUMENT_LLM_API_KEY` (an ambient `OPENAI_API_KEY` is not used).

In the served web Chat, a successful conversion also adds the new
`raw/untracked/*.md` path as a document-context badge. Up to five wiki or
pending Markdown documents can be selected. Only their paths are sent to
Donna; she reads the relevant documents through the configured read-only MCP
tools when the question refers to them. This does not ingest the document:
`wiki ingest` remains the explicit transition into the durable wiki.

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
  TUI clipboard bridge. Message headers expose a `[ copy ]` target for copying
  one message, and user questions also carry `[ redo ]`: it discards every
  answer, plan step and activity recorded after that question — in the runtime
  as well as on screen — then re-asks it. Redo is refused while a run is still
  active; cancel it first. PageUp/PageDown remain available for keyboard
  scrolling.
- **Right** — Plan/Queue tabs, active MCP jobs, plus a live log/trace panel.
  Click `Plan` or `Queue (N)` to select a tab. `Queue (N)` counts run requests
  sent while the runtime is already busy, so it reads `(0)` whenever you submit
  one request at a time. MCP connection details remain available through
  `/mcp status`.

In the served browser Activity panel, `Clear` is a per-tab display cleanup and
`Clear all` applies it to Plan, Local activity, Runtime activity, and Logs. It
does not delete a plan. **Reset plan** is the confirmed destructive operation:
it stops active work and purges the workspace runtime plan, activities, logs,
queue, and persisted runtime state. Donna can perform the same operation when
the user explicitly asks to delete, reset, abandon, or replace the current
plan. A request that only says to stop or cancel remains non-purging.

Useful primitives:

```text
/workspace list
/new <name> [path]              # interactive TUI wizard
/workspace init <name> [path]   # low-level non-interactive creation
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
/queue
/queue cancel <id>
/queue clear
/approve [run|item] <id>
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

Executable skills are resolved by the runtime, not expanded into a private LLM
prompt by each UI. `/skills run <name>` and `/<name>` therefore use the same
path in the Shell and in `llm-wiki serve`; headless `--skill` posts the same
invocation to `/run`. Built-in commands keep priority (`/status` remains the
Shell status primitive), while `/skills run status` explicitly selects a skill
with the same name.

Donna receives only the sanitized skill catalogue (name, description and
parameters) when selecting a skill from natural language. The runtime rereads
and compiles the body after selection. Conversation, queue, audit, SSE and run
records expose only the public invocation, for example
`/wiki-build template="overview"`; the compiled objective remains private
execution material. An informational question about a skill therefore remains
a question—it does not launch that skill. A natural-language action launches a
skill only when Donna finds one strong, unique match and all required parameters
are present; an explicit command always wins.

Every skill may declare its execution policy in front matter:

```yaml
---
name: new-template
description: Create one reusable deliverable template
execution: direct
params:
  - family
  - intent
---
```

`execution: orchestrated` is the default. It gives the compiled run read tools
plus capability delegation, but no direct mutating MCP tools. Use it for
production workflows whose agents provide a plan, locks, progress and bounded
approvals. `execution: direct` gives the compiled run its ordinary direct tools
and removes runtime delegation; use it for a focused operation such as writing
one template file. The policy is snapshotted when the chain is created, so an
edited skill cannot change permissions halfway through an existing chain.

The runtime compiles a skill into natural-language objectives. Paragraphs alone
do not split work: an existing complex capability such as `knowledge.pipeline`
stays one objective, one capability resolution and one run. Strong workflow
boundaries create a sequential execution chain instead. In the shipped
scaffold, `pipeline`, `wiki-ingest`, `wiki-build`, `deliver`, `diagnose`,
`status` and `new-template` each compile to one run; `wiki-sync` compiles to an
export run followed by an ingest run. Chain items contain `chainId`, sequence,
optionality and continuation policy, but never a precomputed `capabilityPlan`.
Each item is resolved only when its run starts.

Writing a skill body is a contract with that compiler: its markdown shape decides
the number of runs, the approval boundaries and whether a capability keeps its
own concurrency. [`docs/authoring-skills.md`](authoring-skills.md) is the
reference for it.

`/run cancel` cancels the current run and skips only the remaining required
items of the same chain. It leaves standalone requests and other chains intact.
`/run kill` deliberately keeps its broader workspace scope and purges every
queued control request. `/queue cancel <id>` remains item-scoped. The Activity
views in both UIs derive their Chain section from the event-sourced control
queue, including `skipped` and `skipReason`; no separate chain state exists.

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
arbitrary system commands, `/wiki run`, `/start`, `/stop`, `/logs`,
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
`--skill "<name> [arguments...]"` submits `/<name> <arguments...>` to the same
runtime resolver used by the Shell and Serve. It waits for the complete
`chainId`, not only the first run: every control item must become terminal, and
any failed item yields exit code 1. A chain waiting for approval returns
immediately with guidance unless `--auto-approve` was requested. Combining
`--prompt` with runtime `--skill` ignores the prompt and reports that fact in
the headless log. `--no-runtime` keeps the legacy local execution path as an
explicit compatibility mode, but it still enforces the skill's declared
`execution` policy. A direct legacy skill requires the explicit
`--auto-approve` opt-in before receiving direct tools.

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

## Orchestration Contract

Beyond `_activity`, an MCP server can become a fully **orchestrable agent** by
exposing five tools: `agent_describe` (capabilities, limits, health),
`agent_plan` (returns a task-graph fragment for an objective — planner agents
only), `agent_execute` (starts one bounded, idempotent task), `agent_status`
and `agent_cancel`. The manager discovers these at startup and on a periodic
re-scan, and routes tasks by capability: workspace config can pin
`preferredAgents` / `allowedAgents` / `fallbackAgents` per capability under
`capabilityRouting`. Executor-only agents (like `agent-cme`) declare
`canPlan: false` and receive single tasks planned elsewhere. Mutating
operations must carry an `idempotencyKey` — the agent persists key→job
mappings so a retry never duplicates work. Capabilities that mutate external
systems should declare `defaultRequiresApproval: true`; the manager then
requires a bounded approval (scoped to run, plan revision and approval class)
before dispatch. Contracts and schemas live in
`plan-directeur-orchestration.md` at the wikiLLM workspace root and in
`src/contracts/schemas.js`.

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
pnpm run check-versions
pnpm run check
```

When bumping a coordinated release, keep `llm-wiki`, `llm-wiki-manager`, Python
agent `_AGENT_VERSION` values, MCP `clientInfo.version` / server versions, Git
tags, and Docker image tags aligned. Run:

```bash
pnpm run check-versions
CHECK_GIT_TAG=1 pnpm run check-versions          # pre-release tag check
CHECK_DOCKER_IMAGES=1 pnpm run check-versions    # after local image build
```

`build-and-push.sh` synchronizes the coordinated version, runs
`pnpm run check-versions`, builds images tagged with that version, and can push
the matching `latest` tags.

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
├── agents.docker-compose.yml  # packaged global external agents
├── wiki-workspace
├── .env.example            # template for local .env (WORKSPACES_ROOT, agent tokens, …)
├── mcp.endpoints.example.json
└── workspaces/.env.example
```

## License

Released under the PolyForm Noncommercial License 1.0.0. See [`LICENSE`](../LICENSE).
