# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

`agentdocs-mcp` — the stdio **MCP server for [AgentDocs](https://agentdocs.eu)**, published to npm
and listed in the official MCP registry as `io.github.hoornet/agentdocs-mcp`. It gives MCP clients
read/search/write access to AgentDocs Markdown docs.

ESM (`"type": "module"`), TypeScript, Node `>=20`, no runtime framework. Dependencies are just
`@modelcontextprotocol/sdk` and `zod`.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | entry point — builds the `McpServer`, wires stdio transport, registers tools |
| `src/config.ts` | env/config loading (`AGENTDOCS_TOKEN`, `AGENTDOCS_URL`) |
| `src/client.ts` | HTTP client for the AgentDocs API (`ApiError`) |
| `src/resolve.ts` | slug-or-UUID addressing |
| `src/context.ts` | shared `ToolContext` / `CredentialInfo` types |
| `src/tools/{read,write,share,comments}.ts` | the MCP tool registrations |
| `test/*.mjs` | smoke scripts, run by hand (there is **no** `npm test` script) |
| `docs/PUBLISHING.md` | release procedure + directory/registry listings |
| `server.json` | official MCP registry manifest — version must match the published npm version |

Build with `npm run build` (`tsc` → `dist/`). `npm run watch` for incremental.

## Two invariants that have each caused a shipped bug

**1. The version lives in `package.json` and nowhere else.**
`src/index.ts` derives it at runtime via `createRequire(import.meta.url)("../package.json").version`.
Do **not** "simplify" this into a hardcoded `VERSION` string. A hand-maintained literal is precisely
what silently drifted two releases behind and made 0.6.0/0.6.1 report `0.5.2` to every client in the
MCP `initialize` handshake. Fixed in 0.6.2 — keep it derived.

**2. Never trust a lifecycle hook to produce the build.**
Publish with **`npm run release`** (= `npm run build && npm publish`), not bare `npm publish`.

`prepublishOnly` is a *lifecycle* hook, so it is skipped — **silently, with no warning** — on any
machine with `ignore-scripts=true` in `~/.npmrc`, with a `--ignore-scripts` flag, or on a CI runner
configured that way. `npm publish` would then package whatever stale `dist/` is on disk. Because
`files: ["dist"]` and `bin` → `dist/index.js`, that ships a broken or outdated server to everyone
running it through `npx`. An explicitly invoked `npm run <script>` is never suppressed by
`ignore-scripts`, which is why `release` chains the build instead of relying on the hook.

`prepublishOnly` is deliberately retained as a fallback for anyone who publishes without `release`.

## Releasing

Follow [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — it covers the npm release, the official MCP
registry (`mcp-publisher` + `server.json` + the `mcpName` field), and the other directory listings.

Note that publishing requires the maintainer's npm login and 2FA (the account holds **no** access
tokens by design), so **an agent cannot complete a release** — prepare the branch, changelog and
tag, then hand off the `npm run release` step.

## Conventions

- `CHANGELOG.md` follows semver with a `## X.Y.Z — YYYY-MM-DD` heading and `### Added/Fixed/Changed`
  sections. Write the entry as part of the change, not as an afterthought.
- Tags are annotated: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
- Commit subjects use conventional-commit prefixes (`fix:`, `feat:`, `build(deps-dev):`) and often
  carry the version in parentheses, e.g. `fix: report the real version in the MCP handshake (v0.6.2)`.
