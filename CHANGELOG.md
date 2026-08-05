# Changelog

All notable changes to `agentdocs-mcp` are documented here. Versions follow
[semver](https://semver.org/); the package is the stdio MCP server for
[AgentDocs](https://agentdocs.eu).

## 0.9.1 — 2026-08-05

### Fixed
- **The server no longer refuses to start on an unverified credential.** It
  still probes `/api/auth/me` at boot to learn the credential's scope (a
  space-scoped token hides the workspace-level tools), but a 401 — or an
  unreachable API — now logs a warning and serves the full tool surface
  instead of `process.exit(1)`.

  This mattered more than it looked. The MCP handshake and `tools/list` carry
  no credential of their own, and automated clients rely on that: registry
  indexers (Glama, `docker/mcp-registry`'s `build --tools`) boot a server with
  a *placeholder* token purely to enumerate its tools. Exiting first made this
  server un-inspectable by every one of them — Glama reported it as "cannot be
  installed / quality: not tested", and the Docker catalog submission had to
  carry a hand-maintained `tools.json` to work around it.

  The diagnosis the old fail-fast gave up isn't lost, just deferred: the first
  tool call returns the same actionable 401 ("regenerate it at … and update
  AGENTDOCS_TOKEN"). Verified against Glama's exact placeholder token —
  18 tools listed, tool call reports the credential error.

## 0.9.0 — 2026-08-03

### Added
- **MCP tool annotations on all 18 tools** (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`). Read tools (`whoami`, `list_*`, `get_page`,
  `search_docs`, `semantic_search`, `list_comments`) declare `readOnlyHint: true`;
  `delete_page`, `delete_comment`, `update_page` and `update_comment` declare
  `destructiveHint: true`; additive writes (`create_page`, `append_to_page`,
  `add_comment`, `bulk_create_pages`, `share_page`) declare it `false`;
  `import_markdown` declares `idempotentHint: true` (it matches pages by source
  path by design). Every tool sets `openWorldHint: false` — they only ever talk
  to AgentDocs. Clients use these to calibrate permission prompts; Anthropic's
  connector directory expects them. Hosts embedding `registerAllTools()` (the
  hosted remote endpoint) inherit the annotations automatically.

### Changed
- README rewritten for the OAuth era: Claude.ai/Desktop/mobile connect to the
  hosted endpoint with **no token and no headers** — AgentDocs now runs a full
  OAuth 2.1 authorization server with dynamic client registration, so the
  request-header-beta guidance is obsolete. Token setup remains for the local
  stdio server and non-OAuth clients.

## 0.8.0 — 2026-07-26

### Added
- `Config.fetchImpl`: an injectable transport for API calls, defaulting to the
  global `fetch`.

  Motivated by a real production failure. AgentDocs' remote MCP endpoint runs
  *inside* the process that serves the REST API and originally reached it over
  loopback HTTP. On the production platform that process cannot reach itself —
  neither at `127.0.0.1:$PORT` nor on a second loopback listener it binds
  itself — so the transport worked (`initialize`, `tools/list`) while every
  actual tool call failed with "Could not reach http://127.0.0.1:3000".

  With `fetchImpl`, the host can dispatch requests straight into its own HTTP
  app in-process. Permissions, tier limits, provenance and usage metering still
  run in the real middleware, because it is the same app handling the request —
  but there is no network hop to fail.

### Changed
- No behavioural change for the stdio server or any existing consumer:
  `fetchImpl` is optional and the default remains the global `fetch`, including
  the existing cold-start retry.

## 0.7.0 — 2026-07-26

### Added
- The package is now importable as a **library**, not just runnable as a stdio
  binary. New `exports` map with `registerAllTools(server, ctx)` and
  `createMcpServer(ctx, version)` from `dist/lib.js`, plus `AgentDocsClient`,
  `Resolver` and the `ToolContext` / `Config` types. TypeScript declarations
  are now emitted.

  This exists so AgentDocs' backend can mount a **remote (Streamable HTTP)**
  MCP endpoint at `POST /mcp` that registers these exact tool definitions per
  request. Exporting them — rather than copying them into the backend — is what
  keeps the stdio and remote surfaces from drifting apart.
- `Config.authHeader`: a complete `Authorization` header value, used verbatim
  when set. The remote endpoint serves many callers, each with their own header,
  which may be `Bearer <jwt>` rather than `Token <api_token>`. `Config.token`
  is now optional, and unchanged for stdio (still sent as `Token <token>`).
- `"./package.json"` is included in the `exports` map, so tooling that reads it
  (a common pattern for version checks) doesn't hit `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Changed
- No behavioural change to the stdio server. `src/index.ts` now builds its
  server via the shared `createMcpServer()` instead of registering the four tool
  groups inline; the 18 tools, their schemas and descriptions are identical.

## 0.6.2 — 2026-07-11

### Fixed
- The server no longer reports a stale version. `VERSION` was a hardcoded
  `"0.5.2"` literal in `src/index.ts` that had not been updated since the 0.5.2
  release, so both the stdio startup banner and — more importantly — the
  `version` advertised to every client in the MCP `initialize` handshake were
  two releases behind the actual package. It is now read from `package.json` at
  runtime, so it cannot drift again.

## 0.6.1 — 2026-07-06

### Fixed
- `add_comment` tool description no longer claims that `@name` mentions notify
  the mentioned user. The backend only regex-extracts `@name` tokens and echoes
  them back in the `mentions` array (informational); it does not resolve them to
  users or send any notification. The old wording ("Mentioning a user with @name
  notifies them") misled agents into believing a mention would ping a teammate.
  Description-only change — no behaviour change. Actually notifying on mention is
  now a tracked backend feature (AgentDocs ROADMAP, v1.2).

## 0.6.0 — 2026-07-05

### Added
- Comment discovery — `list_pages` and `get_page` now surface `comment_count`,
  `unresolved_comment_count` and `last_comment_at` on every page (listing entries
  include them when non-zero). Comments don't bump a page's `updated_at`, so
  before this an agent syncing by page listings could never notice new replies
  without polling every page's thread — found via dogfooding when an agent
  missed replies posted as page comments. Requires an AgentDocs backend that
  returns the fields (agentdocs.eu does); older backends simply omit them.
- Tool descriptions for `list_pages` / `get_page` now tell the model to check
  `last_comment_at` for new replies and `include_comments` to read the thread.

## 0.5.2 — 2026-06-19

### Added
- `server.json` + `mcpName` in package.json so the server can be listed in the
  official MCP registry (`io.github.hoornet/agentdocs-mcp`). No functional change
  to the server itself.

## 0.5.1 — 2026-06-18

### Changed
- Upgraded `zod` 3 → 4 (dependency). No behavioural change — the MCP SDK
  (`@modelcontextprotocol/sdk` ≥1.29) supports `zod ^3.25 || ^4.0`, and the
  tool input schemas use only basic builders (`z.string/object/boolean` +
  `.optional/.min/.max/.describe/.array`) whose signatures are unchanged in
  Zod 4. Verified: `tsc` clean + full prod smoke suite (27 checks) green.

## 0.5.0 — 2026-06-16

### Added
- `get_page` gains an `include_children` option — returns a page's immediate child
  pages (id, title, slug; no content) alongside the page. Useful for "folder" pages
  whose own content is empty but which organise sub-pages: an agent reading one no
  longer hits a dead end with no hint that children exist. Composes with
  `include_comments` (both can be requested in one call).

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
