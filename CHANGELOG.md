# Changelog

All notable changes to `agentdocs-mcp` are documented here. Versions follow
[semver](https://semver.org/); the package is the stdio MCP server for
[AgentDocs](https://agentdocs.eu).

## 0.4.0 — 2026-06-14

### Added
- Comment write tools — agents can now take part in the discussion thread, not
  just read it:
  - `add_comment` — post a comment on a page; set `parent_comment_id` to reply
    within a thread. `@mentions` notify users and are echoed back.
  - `update_comment` — edit a comment's body and/or mark its thread `resolved`
    (author or admin only).
  - `delete_comment` — permanently delete a comment (author or admin only).
  - `list_comments` — list a page's threaded comments standalone (handy for
    finding a comment's id before editing/deleting; `get_page` with
    `include_comments` returns the same thread alongside the page).
- Comments are addressed by UUID; the tools reject non-UUID ids with a clear hint.

18 tools total.

## 0.3.0 — 2026-06-14

### Added
- `import_markdown` is now **idempotent** and **anchorable**:
  - Re-running an import (or chunking a large vault across several calls) reuses
    existing pages instead of creating `-2` duplicates — matched by source path.
    The response reports `created` / `reused` / `updated` counts.
  - `parent_page` (UUID or slug path) nests the whole import under an existing page.
  - `overwrite_existing` (default false) re-syncs content of pages that already
    exist; off by default so re-import never clobbers in-app edits.

## 0.2.2 — 2026-06-13

### Added
- README: Opencode setup (`opencode.json` `mcp` block) alongside Claude Code / Cursor / Windsurf.

### Fixed
- Feature-gate 403 messages (e.g. `semantic_search` on a Free workspace) no longer
  render a double period before "Upgrade:" — the message now reads cleanly, e.g.
  `Semantic search requires a Pro subscription. Upgrade: https://agentdocs.eu/settings/billing`.

## 0.2.1 — 2026-06-13

### Docs
- Corrected the supported-client list: the stdio server runs in clients that
  launch a local process (Claude Code, Claude Desktop, Cursor, Windsurf, Zed).
  **Claude.ai web is not one of them** — it accepts only remote MCP connectors
  over a URL, so Claude.ai web users should add the hosted Skill
  (`https://agentdocs.eu/agentdocs-skill.md`) instead. A remote (HTTP/SSE) MCP
  endpoint for Claude.ai is on the AgentDocs roadmap.
- No code changes; tool behavior is identical to 0.2.0.

## 0.2.0 — 2026-06-13

### Added
- `semantic_search` — natural-language, meaning-ranked search over a workspace
  (Pro; degrades to a fulltext fallback when embeddings aren't configured).
- `import_markdown` — import a folder of `{ path, content }` Markdown files;
  the folder structure becomes the page hierarchy (an `index.md`/`README.md`
  inside a folder supplies that folder page's content).
- `get_page` gains an `include_comments` option that returns the page and its
  comment thread in a single call.

### Changed
- `search_docs` and `bulk_create_pages` descriptions clarified to disambiguate
  them from `semantic_search` and `import_markdown`.

14 tools total.

## 0.1.0 — 2026-06-09

### Added
- Initial release. Stdio MCP server exposing 12 tools: `whoami`,
  `list_workspaces`, `list_spaces`, `list_pages`, `search_docs`, `get_page`,
  `create_page`, `update_page`, `append_to_page`, `delete_page`, `share_page`,
  `bulk_create_pages`.
- Slug-or-UUID addressing; account tokens and space-scoped tokens (space tokens
  auto-scope the server to their space).
- Neon cold-start resilience (35s timeout + one retry); friendly error messages
  for 401/403/429.
