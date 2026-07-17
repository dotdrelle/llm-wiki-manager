# Configuration reference

This page explains **how wikiLLM is configured**, layer by layer, and the two
families of keys that hold everything together: **MCP keys** (Bearer tokens that
authenticate *who talks to whom*) and **LLM keys** (`apiKey` + `baseUrl` that
*reach a model*).

For the first-run happy path see the **Quick start** in the
[main README](../README.md#quick-start--your-first-wiki-in-5-minutes); for the
four ways to drive the system see [usage.md](usage.md).

![wikiLLM configuration keys — MCP vs LLM, where each key is configured](https://raw.githubusercontent.com/dotdrelle/llm-wiki-manager/main/docs/config-keys.svg)

---

## The mental model

There are **two key families that never mix**:

- **MCP keys** authenticate a *connection*, not a model. They are `Bearer`
  tokens that open an **agent** or the wiki's own MCP endpoint. Any MCP client
  (Donna, Claude desktop, a script, another machine) can connect to those HTTP
  endpoints as long as it presents the right token.
- **LLM keys** reach a *model*. They are `apiKey` + `baseUrl` pairs that point at
  an OpenAI-compatible provider, used by the wiki for chat/build and for vector
  embeddings/reranking.

Mapped onto the four configuration files:

| File | Owner | Scope | Holds |
| --- | --- | --- | --- |
| `llm-wiki-manager/.env` | manager | **global** | shared secrets: agent MCP tokens, MailerSend, OCR LLM, optional provider keys, port overrides |
| `llm-wiki-manager/mcp.endpoints.json` | manager | global | where each external agent lives + which `Bearer`/header to send |
| `workspaces/<name>/.env` | manager | per workspace | ports, workspace path, and the wiki's own MCP tokens |
| `workspaces/<name>/.wikirc.yaml` (+ `.wikirc.yaml.<profile>`) | workspace | per workspace | the LLM and vector configuration (provider/model/apiKey/baseUrl/retrieval) |

> Copy from the shipped examples and never commit real secrets:
> `cp .env.example .env` and `cp mcp.endpoints.example.json mcp.endpoints.json`.
> Both `.env` files are gitignored. `.wikirc.yaml` is workspace-owned — keep it
> out of any public repository because it holds provider keys.

---

## 1. Root `.env` — global shared secrets

Loaded automatically by both `wiki-manager` (the Node/Bun process) and
`wiki-workspace` (Docker Compose). It holds everything shared across workspaces.
LLM/provider configuration for a wiki does **not** live here — it lives in each
workspace `.wikirc.yaml`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `WORKSPACES_ROOT` | yes (for `agents up/down/logs`) | root directory that contains all workspace folders |
| `AGENTS_DATA_DIR` | no | persistent agent state (CME config, document queues). Defaults to `./.agents-data/` |
| `CME_MCP_AUTH_TOKEN` | recommended | Bearer token guarding the CME agent. Must match the header in `mcp.endpoints.json` |
| `DOCUMENTS_MCP_AUTH_TOKEN` | recommended | Bearer token guarding the documents agent |
| `MAILER_MCP_AUTH_TOKEN` | recommended | Bearer token guarding the mailer agent |
| `MAILERSEND_API_KEY` | for mail | MailerSend API key |
| `MAILERSEND_FROM_EMAIL` / `MAILERSEND_FROM_NAME` | for mail | default sender identity |
| `DOCUMENT_LLM_BASE_URL` | no | OpenAI-compatible vision endpoint for document OCR (defaults to OpenAI) |
| `DOCUMENT_LLM_MODEL` | no | OCR model name |
| `DOCUMENT_LLM_API_KEY` | for OCR | key for the OCR provider (or reuse `OPENAI_API_KEY`) |
| `DOCUMENT_LLM_TIMEOUT_SECONDS` | no | OCR request timeout |
| `EXA_MCP_API_KEY` | only if Exa enabled | used by `mcp.endpoints.json` when the Exa endpoint is declared |
| `CME_MCP_PORT` / `DOCUMENTS_MCP_PORT` / `MAILER_MCP_PORT` | no | port overrides (defaults `3336` / `3337` / `3335`) |
| `NODE_USE_ENV_PROXY` | behind an HTTP proxy | set to `1` so the Node runtime's `fetch` calls use `HTTP_PROXY` / `HTTPS_PROXY` |
| `HTTP_PROXY` / `HTTPS_PROXY` | behind an HTTP proxy | proxy URL, including its scheme and port |
| `NO_PROXY` | recommended with a proxy | hosts that must remain direct, notably the local runtime and MCP endpoints |

Leaving an agent's `*_MCP_AUTH_TOKEN` empty disables authentication on that
agent — not recommended outside local development.

### VPN or corporate HTTP proxy

The interactive shell may successfully reach the LLM while a delegated run
still fails during `objective_resolution`: the delegation is prepared by the
separate Node runtime, whose `fetch` implementation only reads the standard
proxy variables when environment-proxy support is enabled.

Add the following to the root `.env` when the proxy is a permanent part of the
manager environment:

```dotenv
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://proxy.example:11011
HTTP_PROXY=http://proxy.example:11011
NO_PROXY=localhost,127.0.0.1,host.docker.internal
```

For a proxy that exists only while a VPN is active, keep
`NODE_USE_ENV_PROXY=1` in `.env` and export the session-specific proxy values
before starting `wiki-manager`:

```bash
export HTTPS_PROXY=http://proxy.example:11011
export HTTP_PROXY=http://proxy.example:11011
export NO_PROXY=localhost,127.0.0.1,host.docker.internal
```

The URL scheme (`http://`) is required for consistent behavior across HTTP
clients. `NO_PROXY` prevents local runtime calls, local MCP calls, and
container-to-host coordination from being sent to the corporate proxy. Without
`HTTP_PROXY` or `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1` does not force a proxy and
normal direct networking remains unchanged.

---

## 2. `mcp.endpoints.json` — wiring the external agents

Declares external agents for the shell, TUI, headless mode, and the served chat
UI. Values support `${VAR}` interpolation resolved from the process environment
(including the `.env` loaded at startup), with `${VAR:-default}` fallbacks.

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
    },
    "mailer": {
      "url": "http://host.docker.internal:${MAILER_MCP_PORT:-3335}/mcp/",
      "headers": { "Authorization": "Bearer ${MAILER_MCP_AUTH_TOKEN}" }
    },
    "exa": {
      "url": "https://mcp.exa.ai/mcp",
      "headers": { "x-api-key": "${EXA_MCP_API_KEY}" }
    }
  }
}
```

**The rule that matters:** the `Bearer` value here must equal the matching
`*_MCP_AUTH_TOKEN` in the root `.env`, otherwise the agent rejects the call.
External agents are workspace-agnostic — the active `/use <workspace>` is
injected automatically on every call. `WIKI_MANAGER_ENDPOINTS_FILE` overrides the
default `./mcp.endpoints.json` path.

Start the shared agents once for all workspaces:

```bash
wiki-workspace agents up
```

---

## 3. Workspace `.env` — ports, path, and the wiki's own MCP tokens

Manager-owned, one per workspace under `workspaces/<name>/.env`. It carries
**only** ports, the workspace path, and the tokens for the wiki's *internal* MCP
servers. No LLM configuration.

| Variable | Purpose |
| --- | --- |
| `WORKSPACE_NAME` | identifier of the workspace |
| `WIKI_WORKSPACE_PATH` | absolute path to the workspace folder |
| `WIKI_SERVE_PORT` | port for the wiki web UI / browser chat (`serve`) |
| `WIKI_MCP_PORT` | port for the llm-wiki MCP endpoint (`mcp-http`) |
| `PRODUCTION_MCP_PORT` | port for the production-job MCP endpoint (`production-mcp`) |
| `PRODUCTION_REQUIRE_CONFIRMATION` | guard requiring confirmation before production jobs run |
| `WIKI_MCP_AUTH_TOKEN` | Bearer guarding the llm-wiki MCP endpoint (alias of `mcp.accessKey`) |
| `PRODUCTION_MCP_AUTH_TOKEN` | Bearer guarding the production-job MCP endpoint |

Create and start a workspace:

```bash
wiki-workspace config my-project [path]
wiki-workspace up my-project
```

These three services map straight onto the ports above:

| Service | Role | Port variable |
| --- | --- | --- |
| `serve` | Wiki web UI and browser chat | `WIKI_SERVE_PORT` |
| `mcp-http` | llm-wiki MCP endpoint | `WIKI_MCP_PORT` |
| `production-mcp` | Production job MCP endpoint | `PRODUCTION_MCP_PORT` |

---

## 4. `.wikirc.yaml` — the wiki's LLM & vector configuration

Workspace-owned. This is where **all LLM keys live** and what `wiki doctor`
reads and writes. It is parsed as YAML `core` schema and must be an object at the
root.

```yaml
language: fr

llm:
  provider: openai-compatible      # or: ollama
  model: deepseek-v4-pro
  apiKey: <PROVIDER_API_KEY>       # LLM key — chat / build model
  baseUrl: https://provider.example/v1
  temperature: 0.1
  timeoutMs: 600000
  numCtx: 32768
  # Ollama-only (set explicitly for remote/Docker Ollama so `doctor` can advise):
  # flashAttention: true
  # kvCacheType: q8_0

build:
  refreshOnIngest: false
  slotBatchSize: 50
  maxBuildContextChars: 15000

limits:
  requestsPerMinute: 40
  targetInputTokensPerCall: 40000
  maxInputTokensPerCall: 70000
  maxProfileChars: 4000
  # dailyInputTokens: 1000000      # optional budget shown by `wiki build --plan`

retrieval:
  maxContextFiles: 8
  maxChunksPerPage: 2
  maxChunkChars: 1100
  maxSourceChars: 98000
  vector:
    enabled: true
    baseUrl: https://embeddings.example/v1   # defaults to llm.baseUrl if omitted
    apiKey: <VECTOR_API_KEY>                 # LLM key — embeddings / reranking
    timeoutMs: 600000
    embeddingModel: BAAI/bge-m3
    rerankEnabled: true
    rerankerModel: BAAI/bge-reranker-v2-m3
    topK: 120
    rerankTopK: 80
    maxResults: 6

mcp:
  # Optional access key for the wiki MCP; equivalent to WIKI_MCP_AUTH_TOKEN.
  accessKey: <WIKI_MCP_ACCESS_KEY>
  # Optional HTTPS for `wiki mcp-http` (paths relative to the workspace root):
  # tls:
  #   certPath: certs/fullchain.pem
  #   keyPath: certs/privkey.pem
  #   caPath: certs/ca.pem
```

Key blocks:

- **`llm`** — the chat/build model. `llm.apiKey` + `llm.baseUrl` are the primary
  LLM keys. `provider` is `openai-compatible` for hosted APIs or `ollama` for a
  local server.
- **`retrieval.vector`** — embeddings and reranking for retrieval-grounded
  answers. It can target a *different* provider via its own `baseUrl`/`apiKey`
  (e.g. chat on one service, embeddings on another). Defaults to `llm.baseUrl`.
- **`build` / `limits`** — batching and token/rate budgets, tuned per provider.
- **`mcp.accessKey`** — protects the wiki MCP; the env equivalent is
  `WIKI_MCP_AUTH_TOKEN` (handy for Docker-only deployments).

Run `wiki doctor` after changing the model, context size, retrieval limits, or
Ollama settings. When suggestions exist, `doctor` prints the exact keys to change
and `wiki doctor --apply` writes them for you.

### Provider profiles — `.wikirc.yaml.<name>`

`.wikirc.yaml.<name>` files are **interchangeable profiles** for the same
workspace. Any file named `.wikirc.yaml` or `.wikirc.yaml.<name>` is discovered
automatically:

- `.wikirc.yaml` → the `default` profile
- `.wikirc.yaml.openai` → profile `openai`, `.deepseek`, `.nvidia`,
  `.albert-mistral`, `.albert-openai`, …

Each profile typically swaps the **provider/model + baseUrl + apiKey** and tunes
`limits`/`retrieval` accordingly (for example a provider with a large context
window raises `maxInputTokensPerCall`, while smaller models reduce chunk sizes).

Switch profiles from the `donna` shell:

```text
/config status      # show the active profile and its summary
/config edit        # open the active .wikirc.yaml
/config             # inspect / switch profiles
```

The active profile is passed to the containers via `WIKI_CONFIG_PATH`, so a
selected `.wikirc.yaml.<name>` drives the running services.

---

## How the keys connect, end to end

1. **Donna → external agents** — Donna reads `mcp.endpoints.json`, sends the
   `Bearer` token (configured in the **root `.env`**), and the agent accepts the
   call when the token matches.
2. **Donna → wiki MCP (internal)** — Donna reaches the workspace's own MCP
   (`serve` / `mcp-http` / `production-mcp`) using `WIKI_MCP_AUTH_TOKEN` /
   `mcp.accessKey` from the **workspace `.env`** / `.wikirc.yaml`.
3. **Wiki → models** — the wiki uses the **LLM keys** in `.wikirc.yaml`
   (`llm.apiKey`/`baseUrl` for chat & build, `retrieval.vector.apiKey`/`baseUrl`
   for embeddings & reranking).
4. **Remote clients → either MCP surface** — because the agents and the wiki MCP
   are HTTP endpoints, any MCP client elsewhere can connect to them with the same
   Bearer tokens.

In one line: **an MCP token is a pass between a client and an endpoint; an LLM
key is access to the model a workspace uses.**

---

## Security notes

- MCP tokens are local coordination secrets; store them in `.env` (gitignored),
  never in committed docs.
- Provider API keys belong in the workspace `.wikirc.yaml` or the owning service
  environment — keep `.wikirc.yaml` files out of public repositories.
- Workspace names are path-safe identifiers (no `..`, alphanumeric edges).
- `.wikirc.yaml` must be a valid YAML object; invalid YAML or a non-object root
  is rejected on load.
- `.env` quoted values support basic escapes (`\"`, `\\`, `\n`, `\r`, `\t`).
