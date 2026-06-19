# Publishing & directory listings

How `agentdocs-mcp` gets published to npm and listed in MCP directories.

## npm release (every version)
1. Bump **both** `package.json` `version` and the `VERSION` const in `src/index.ts` (must match).
2. Add a `CHANGELOG.md` entry.
3. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --follow-tags`.
4. `npm publish --otp=<code>` (needs the maintainer's npm login + 2FA; `prepublishOnly` runs `npm run build`).
5. Cold-verify: `npx -y agentdocs-mcp@X.Y.Z` boots and prints the version banner.

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
