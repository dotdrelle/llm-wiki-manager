# Using wikiLLM MCP servers with Claude Desktop

All MCP servers in this project are compatible with Claude Desktop. The
connection method depends on the transport each server uses.

## Transport overview

| Server | Transport | Default port |
|---|---|---|
| `llm-wiki mcp` | stdio | — |
| `llm-wiki mcp-http` | Streamable HTTP | 3101 |
| `agent-wiki-production` | Streamable HTTP | 3102 |
| `agent-cme` | Streamable HTTP | 3336 |
| `agent-external/documents` | Streamable HTTP | 3337 |
| `agent-mailer-api` | Streamable HTTP | 3335 |

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
    },
    "mailer": {
      "url": "http://localhost:3335/mcp/",
      "headers": {
        "Authorization": "Bearer <MAILER_MCP_AUTH_TOKEN>"
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
