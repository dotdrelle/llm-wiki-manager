# Using wikiLLM with Claude Desktop

The recommended local integration uses the two packages built in
`plugins/llm-wiki`:

- `dist/llm-wiki-claude.mcpb`: the local MCP extension. It starts the connector
  on the Mac and discovers the workspaces registered by `wiki-manager`.
- `dist/llm-wiki.plugin`: the Claude skill and its usage instructions.

This integration does not require ShellUI, `serve`, or a manually edited MCP
JSON file. It needs Node.js 22 or later on the `PATH` Claude Desktop sees (the
engine requires it) and a built engine (`pnpm build` in `llm-wiki/`).

## Install the packaged integration

From the plugin directory, build the two files if necessary:

```bash
node scripts/build-mcpb.mjs
node scripts/build-claude-plugin.mjs
```

In Claude Desktop:

1. Open **Settings → Extensions → Install Extension** and select
   `dist/llm-wiki-claude.mcpb`.
2. Set **wiki-manager state directory** to the directory containing the
   workspace registry (`workspaces/`). Pick a permanent directory: one under
   `/tmp` is emptied at reboot and the extension then starts with no
   workspace.
3. Set **wiki-workspace installation directory** to the `llm-wiki` directory
   containing `dist/bin/wiki.js`.
4. Open **Settings → Plugins → Import plugin** and select
   `dist/llm-wiki.plugin`.
5. Restart Claude Desktop, or disable and re-enable the extension.

The extension discovers every initialized workspace in the manager registry
and starts one engine process (`wiki.js mcp`) per workspace; an uninitialized
workspace is skipped and named in the extension log. In a conversation, use
`wiki_workspace_list`, select one with `wiki_workspace_select`, then use the
standard `wiki_*` tools, which are routed to the active workspace only. With a
single workspace it is selected automatically.

Current limits of the multi-workspace mode:

- The active workspace lives in the extension process, which Claude Desktop
  normally shares between conversations: selecting a workspace in one
  conversation changes it for the others (`wiki_workspace_current` tells).
- No tool queries several workspaces at once: compare two workspaces by
  selecting them one after the other.
- The registry is read at start-up only: a workspace added or initialized
  later appears after the extension is restarted.
- Every workspace keeps its engine process for the whole session.
- Only one ingestion is tracked at a time; `wiki_ingest_stop` stops the last
  one started.
- Writes (`wiki_write_page`, `wiki_add_source`, `template_write`,
  `profile_update`) go straight to the engine, not through Donna; the engine
  still refuses them while a production job writes the wiki.

## Update the integration

`dist/` is not versioned. After pulling `plugins/llm-wiki`, rebuild both files,
reinstall the `.mcpb` (and re-import the `.plugin` if the skill changed), then
disable and re-enable the extension. The workspace release script
(`build-and-push.sh`) syncs the connector constant and both manifests to the
coordinated version and rebuilds `dist/`; the manager's `check-versions` also
verifies those three numbers when the repository is checked out. The connector,
the `.mcpb` manifest and
the plugin manifest carry one version, checked by `node
scripts/check-versions.mjs` and by both build scripts; the running connector
reports it as `serverInfo.version`. To check that the installed connector is
the source one:

```bash
diff -q "$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.dotdrelle.llm-wiki-claude/bin/llm-wiki-connect.mjs" \
  plugins/llm-wiki/bin/llm-wiki-connect.mjs && echo "up to date"
```

A connector older than 0.6.0 crashes on `wiki_ingest` (the ingestion keeps
running, the extension's tools disappear): reinstall it.

The engine field expects the parent directory, not the `wiki.js` file and not
`dist/bin` itself. For a development checkout it is the `llm-wiki/` repository
after running `pnpm build`. For an npm-local installation it is the package
directory under `node_modules/llm-wiki/`. For an npm-global installation, find
it with:

```bash
npm root -g
test -f "$(npm root -g)/llm-wiki/dist/bin/wiki.js" && echo "wiki.js trouvé"
```

Select `$(npm root -g)/llm-wiki/` in Claude Desktop. The literal `$()` is only
for the terminal command; Claude's folder picker needs the resolved absolute
path.

Examples:

```text
Sélectionne le workspace ACPI.
Recherche les informations sur le dernier COPIL.
Lance l’ingestion des sources en attente.
Exécute /wiki doctor sur ACPI.
```

`wiki_ingest` is the native ingestion command. `doctor`, `run`, `build`, and
`export` are native `wiki-workspace` commands exposed through
`wiki_command_run`; they are not workspace skills, and `run` passes its
arguments to the engine unchanged. A skill declared under `.wiki/skills/` is
listed with `wiki_skill_list` and executed with `wiki_skill_run` through
`wiki-manager --headless --skill`, without auto-approval: a mutating skill
stops on its approval, which is given in the ShellUI or `serve`.

## Manual stdio configuration

The packaged extension above is preferred for local multi-workspace use. The
following manual configuration remains available when an MCP client cannot
install `.mcpb` packages.

All MCP servers in this project are compatible with Claude Desktop. The
connection method depends on the transport each server uses.

## Transport overview

| Server | Transport | Default port |
|---|---|---|
| `llm-wiki mcp` | stdio | — |
| `llm-wiki mcp-http` | Streamable HTTP | 3101 |
| `agent-production` | Streamable HTTP | 3102 |
| `agent-cme` | Streamable HTTP | 3336 |
| `agent-external/documents` | Streamable HTTP | 3337 |

---

## stdio: llm-wiki mcp

The `wiki mcp` command speaks the MCP stdio transport that Claude Desktop
supports natively. No server process needs to be running beforehand.

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the equivalent path on Windows:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "pnpm",
      "args": ["--prefix", "/absolute/path/to/llm-wiki", "dev", "mcp"],
      "env": {
        "WIKI_WORKSPACE_PATH": "/absolute/path/to/your/workspace"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The `wiki` server appears in the
connector list immediately.

---

## Streamable HTTP servers

Claude Desktop (0.7+) supports remote MCP servers via HTTP. The agents in this
project expose a `/mcp/` endpoint and require a bearer token.

> **Important:** Claude Desktop does not interpolate shell variables in config
> values. Replace every `${VAR}` with its literal value — copy the token from
> your `.env` file.

### Prerequisites

The Docker containers must be running before Claude Desktop connects:

```bash
# from llm-wiki-manager/
wiki-workspace agents up
# or for a specific workspace:
wiki-workspace up --alias all
```

### Config block

Add an entry for each server you want to expose. On macOS, `localhost` works
when Docker Desktop is running; on Linux, use `127.0.0.1`.

```json
{
  "mcpServers": {
    "wiki-mcp": {
      "url": "http://localhost:3101/mcp",
      "headers": {
        "Authorization": "Bearer <WIKI_MCP_AUTH_TOKEN>"
      }
    },
    "wiki-production": {
      "url": "http://localhost:3102/mcp/",
      "headers": {
        "Authorization": "Bearer <PRODUCTION_MCP_AUTH_TOKEN>"
      }
    },
    "cme": {
      "url": "http://localhost:3336/mcp/",
      "headers": {
        "Authorization": "Bearer <CME_MCP_AUTH_TOKEN>"
      }
    },
    "documents": {
      "url": "http://localhost:3337/mcp/",
      "headers": {
        "Authorization": "Bearer <DOCUMENTS_MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Replace each `<…>` placeholder with the matching value from your workspace
`.env` or the `llm-wiki-manager/.env` file.

### Non-default ports

If you changed any port via environment variables (e.g.
`PRODUCTION_MCP_PORT=3200`), use that port in the URL instead of the default.

### TLS

If you configured TLS for `mcp-http` (`WIKI_MCP_TLS_CERT_PATH` /
`WIKI_MCP_TLS_KEY_PATH`), change `http://` to `https://` in the URL. Claude
Desktop validates TLS certificates — use a trusted CA or add your CA to the
system trust store.

---

## Combining stdio and HTTP in one config

You can connect both the stdio wiki server and the HTTP agents at the same time:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "pnpm",
      "args": ["--prefix", "/absolute/path/to/llm-wiki", "dev", "mcp"],
      "env": { "WIKI_WORKSPACE_PATH": "/absolute/path/to/your/workspace" }
    },
    "wiki-production": {
      "url": "http://localhost:3102/mcp/",
      "headers": { "Authorization": "Bearer <PRODUCTION_MCP_AUTH_TOKEN>" }
    },
    "cme": {
      "url": "http://localhost:3336/mcp/",
      "headers": { "Authorization": "Bearer <CME_MCP_AUTH_TOKEN>" }
    }
  }
}
```

---

## Verifying the connection

1. Open Claude Desktop and start a new conversation.
2. Click the tools icon (hammer) — connected servers appear in the list.
3. Ask Claude to call a tool to confirm: `What tools does the wiki server expose?`

If a server does not appear, check that:
- The Docker container is running (`docker ps`).
- The token in the config matches the one in `.env`.
- No firewall blocks the port on localhost.
