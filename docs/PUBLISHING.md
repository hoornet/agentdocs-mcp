# Publishing & directory listings

How `agentdocs-mcp` gets published to npm and listed in MCP directories.

## npm release (every version)
1. Bump `version` in **`package.json` only**. `src/index.ts` *derives* `VERSION` from
   `package.json` at runtime (`createRequire(...)("../package.json").version`).
   **Never re-introduce a hardcoded `VERSION` literal** — a hand-maintained copy is exactly
   what silently drifted two releases behind and shipped the wrong version in the MCP
   `initialize` handshake through 0.6.0/0.6.1. Fixed in 0.6.2; keep it derived.
2. Add a `CHANGELOG.md` entry.
3. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --follow-tags`.
4. **`npm run release`** (= `npm run build && npm publish`), adding `--otp=<code>` if npm
   prompts. Needs the maintainer's npm login + 2FA.
   > ⚠️ **Do not rely on `prepublishOnly` to build.** It is a *lifecycle* hook, and any
   > machine with `ignore-scripts=true` in its `~/.npmrc` — or a `--ignore-scripts` flag, or a
   > CI runner configured that way — skips **all** lifecycle hooks **silently, with no warning**.
   > `npm publish` would then package whatever stale `dist/` happens to be on disk; since
   > `files: ["dist"]` and `bin` → `dist/index.js`, that ships a broken or outdated server to
   > everyone running it via `npx`. An explicitly invoked `npm run <script>` is **never**
   > suppressed by `ignore-scripts`, which is why the `release` script chains the build
   > rather than trusting the hook. (`prepublishOnly` is kept as a belt-and-braces fallback
   > for anyone publishing without it.)
5. Verify `dist/` is actually fresh before/after publishing — `ls -la dist/` timestamps should
   post-date your last `src/` edit. Note npm normalises all mtimes to `1985-10-26` *inside*
   published tarballs, so you cannot check staleness from a downloaded `.tgz`.
6. Cold-verify: `npx -y agentdocs-mcp@X.Y.Z` boots and prints the version banner — confirm the
   banner shows **X.Y.Z**, which is the end-to-end check that the build was fresh.

## Official MCP registry (`modelcontextprotocol/registry`)
Listed as **`io.github.hoornet/agentdocs-mcp`** via `server.json` (in repo root).
- The registry verifies npm ownership through the top-level **`mcpName`** field in the
  **published** `package.json` — so the npm package must be (re)published *after* `mcpName`
  was added (v0.5.2+).
- `server.json` `version` and `packages[].version` must match the published npm version.
- Publish/update the listing with the official **`mcp-publisher`** CLI from the repo root;
  it reads `server.json` and authenticates via **GitHub OAuth** to prove the `io.github.hoornet`
  namespace. (Maintainer step — needs the GitHub login.)
- On each new npm release, bump `version` in `server.json` to match and re-run `mcp-publisher`.

## Other directories (no republish needed — they pull from npm/GitHub)
Use the reusable copy below.

- **awesome-mcp-servers** (`punkpeye/awesome-mcp-servers`) — open a PR adding this line under
  `🧠 Knowledge & Memory` (alphabetical by repo name):
  ```
  - [hoornet/agentdocs-mcp](https://github.com/hoornet/agentdocs-mcp) 📇 ☁️ 🏠 🍎 🪟 🐧 - Read, search (full-text + semantic), create, update, comment on and share AgentDocs (agentdocs.eu) Markdown docs — AI agents as first-class collaborators.
  ```
- **mcp.so**, **Glama.ai**, **PulseMCP**, **Smithery.ai** — web submission forms; they auto-index
  from npm/GitHub. Paste the reusable copy.

## Reusable listing copy
- **Name:** AgentDocs MCP
- **Package:** `agentdocs-mcp` (npm) · **Repo:** github.com/hoornet/agentdocs-mcp · **License:** MIT
- **Tagline:** Give your AI agent read/write access to collaborative docs — agents as first-class citizens.
- **Description:** MCP server for AgentDocs (agentdocs.eu): 18 tools to read, search (full-text +
  pgvector semantic), create, update, comment on, and share Markdown docs. Slug-or-UUID addressing;
  account or space-scoped tokens (sandbox an agent to one space). Self-hostable via `AGENTDOCS_URL`.
- **Install:** `claude mcp add agentdocs --env AGENTDOCS_TOKEN=<token> -- npx -y agentdocs-mcp`
- **Tags:** documentation, knowledge-base, markdown, collaboration, semantic-search, writing
