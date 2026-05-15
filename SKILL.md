---
name: agent-cme-llm-wiki-copy
description: Copy agent-cme Confluence exports into an llm-wiki workspace, using agent-cme MCP when available and shell/CLI fallback when needed. Use when the user wants to refresh Confluence data, copy configured agent-cme exports into a workspace raw/untracked directory, then run llm-wiki doctor, ingest, build, plan, and export safely without duplicating secrets or forcing full reprocessing.
---

# agent-cme -> llm-wiki Copy

Use this skill to move data through the intended pipeline:

```text
Confluence -> agent-cme export -> llm-wiki raw/untracked -> wiki ingest -> raw/ingested + wiki pages
```

agent-cme is the exporter. llm-wiki is the importer/knowledge base. Do not make agent-cme write directly into arbitrary workspaces unless the user explicitly asks.

## Roles

- agent-cme MCP manages Confluence credentials, export sources, and export jobs.
- llm-wiki workspace receives markdown under `raw/untracked`.
- `wiki ingest` transforms `raw/untracked` into `wiki/` content and archives sources to `raw/ingested`.
- `mcp.accessKey` protects llm-wiki's own MCP server; it is not a generic key for every external MCP.
- `limits.*` and `wiki build --plan` describe llm-wiki build request budgets; they do not throttle agent-cme exports.

## Preconditions

Find or confirm:

- agent-cme export root, usually `../agent-cme/data/exports` from this manager directory.
- Target workspace name from `workspaces/<workspace>.env`.
- Explicit import paths listed in `WIKI_IMPORTS`.

If the workspace env file is missing, create it from `workspaces/.env.example`. If the workspace is not configured, ask the user for the workspace name, path, ports, and import paths before editing the local `workspaces/<workspace>.env`.

## Preferred Workflow

1. Check agent-cme readiness.
   - If agent-cme MCP is available, call `cme_status`.
   - If not configured, ask for setup details or stop.

2. Check or run the export.
   - Call `cme_sources_list`.
   - If the user asked for fresh data, call `cme_export_run(source_name=...)`.
   - Poll `cme_export_status(job_id=...)` until `success`, `failed`, `error`, or `cancelled`.

3. Copy markdown into the workspace.
   - Prefer markdown-only copy; do not copy attachments unless explicitly requested.
   - Copy only the explicit `imports` paths configured for the target workspace.
   - If `imports` is omitted or empty, copy nothing.
   - The manager copies each import into the workspace `raw/untracked` tree; `wiki ingest` processes everything under that workspace's `raw/untracked`.

Preferred manager command:

```bash
./wiki-workspace wiki <workspace> copy
```

Equivalent shell copy for one configured import:

```bash
rsync -a \
  --include='*/' \
  --include='*.md' \
  --exclude='*' \
  "<configured-import-path>/" \
  "<workspace-path>/raw/untracked/"
```

4. Run a pre-ingest diagnostic.

```bash
./wiki-workspace wiki <workspace> doctor
```

or, from inside the workspace with the `wiki` CLI available:

```bash
wiki doctor
```

5. Ingest without force.

```bash
./wiki-workspace wiki <workspace> ingest
```

or:

```bash
wiki ingest
```

Never add `--force` unless the user explicitly wants all sources reprocessed.

6. Build configured deliverables.

```bash
./wiki-workspace wiki <workspace> build --plan
./wiki-workspace wiki <workspace> build
```

or:

```bash
wiki build
```

7. Export deliverables when requested.

```bash
./wiki-workspace wiki <workspace> export
```

or:

```bash
wiki export
```

8. Verify results.

Check:

```bash
find "<workspace-path>/raw/untracked" -type f -name '*.md' | wc -l
find "<workspace-path>/raw/ingested" -type f -name '*.md' | wc -l
```

Expected behavior:

- unchanged sources are skipped by `wiki ingest` when their archived path and byte content match;
- changed or moved CME files are reprocessed;
- after successful ingest, processed files are moved from `raw/untracked` to `raw/ingested`;
- vector indexing may run after ingest, but it reuses unchanged embeddings and indexes wiki pages, not raw source files directly.

## Desktop vs CLI Behavior

If running in an agent with shell access:

- perform the copy step directly;
- run `wiki doctor`, `wiki ingest`, `wiki build`, then `wiki export` when requested;
- summarize copied file count, skipped/processed ingest results, and any warnings.

If running in a desktop agent with only MCP access:

- agent-cme MCP can run exports, but it cannot copy files into arbitrary local workspaces by itself.
- llm-wiki MCP currently exposes wiki operations, not a dedicated `import cme` tool.
- In that case, provide the exact copy command for the user or request a filesystem-capable tool.

## Warnings

- `ingest:citation-path-rewrite` is usually non-fatal. It means llm-wiki corrected source citations to the archive path for the current source.
- If a copied export causes every file to be reprocessed, compare `raw/untracked` and `raw/ingested`. CME breadcrumbs, relative links, and moved pages can change file bytes even when business content looks unchanged.
- Do not delete `raw/ingested` to "fix" duplicate ingestion. That removes the skip baseline.
- Do not copy attachments into `raw/untracked` unless the ingest flow supports them.

## Workspace Autonomy

This repository root can act as one autonomous workspace bundle: compose files, agent-cme data, llm-wiki workspace configuration, and this copy workflow live together.

For several workspaces, prefer one manager root with one `workspaces/<workspace>.env` file per workspace, one compose file, and unique ports per workspace.

agent-cme may be shared, but a workspace can also carry its own agent-cme instance if it needs isolated credentials, exports, or ports.
