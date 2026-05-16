---
name: agent-cme-llm-wiki-pipeline
description: Run the Confluence → wiki pipeline for a workspace. agent-cme exports directly into raw/untracked; no copy step needed. Use when the user wants to refresh Confluence data and rebuild the wiki.
---

# Confluence → llm-wiki Pipeline

```text
Confluence -> cme_export_run -> <workspace>/raw/untracked -> wiki ingest -> wiki build -> wiki export
```

agent-cme writes exports **directly** into the workspace `raw/untracked` directory via a Docker volume mount. There is no copy step for CME-sourced data.

## Roles

- agent-cme MCP manages Confluence credentials, export sources, and export jobs.
- llm-wiki workspace receives markdown under `raw/untracked`.
- `wiki ingest` transforms `raw/untracked` into `wiki/` content and archives sources to `raw/ingested`.
- `wiki build` generates deliverables from templates and build context.

## Preconditions

Confirm:

- Workspace name (listed in `workspaces/<name>/.env`).
- CME MCP is running for the workspace (`./wiki-workspace cme <workspace> up`).
- CME is configured (`cme_status` returns `configured`).

If the workspace does not exist yet, create it first:

```bash
./wiki-workspace config <workspace> [path]
```

## Workflow

### 1. Check CME readiness

```
cme_status
```

- `configured` → proceed.
- `not_configured` → call `cme_setup(base_url, username, pat, verify_ssl)`.

### 2. Check or run export

```
cme_sources_list()
cme_export_run()                      # all sources
cme_export_run(source_name="space")   # one source
cme_export_status(job_id=...)         # poll until success / failed
```

Exports land in `<workspace>/raw/untracked/` automatically.

### 3. Run wiki pipeline

```bash
./wiki-workspace wiki <workspace> doctor
./wiki-workspace wiki <workspace> ingest
./wiki-workspace wiki <workspace> build --plan
./wiki-workspace wiki <workspace> build
./wiki-workspace wiki <workspace> export
```

### 4. Verify results

```bash
find "<workspace-path>/raw/untracked" -type f -name '*.md' | wc -l
find "<workspace-path>/raw/ingested" -type f -name '*.md' | wc -l
```

Expected: after ingest, processed files move from `raw/untracked` to `raw/ingested`.

## Warnings

- `ingest:citation-path-rewrite` is usually non-fatal.
- Do not add `--force` to ingest unless the user explicitly wants all sources reprocessed.
- Do not delete `raw/ingested` to "fix" duplicate ingestion — that removes the skip baseline.
- Do not copy attachments into `raw/untracked`.
