# Security Policy

## Reporting a vulnerability

Please report security issues **privately** to **contact@agentdocs.eu** — do not
open a public GitHub issue for vulnerabilities.

This applies both to this MCP server and to the AgentDocs platform
(https://agentdocs.eu) itself.

## Scope notes for users

- This server runs locally and talks only to the AgentDocs instance configured
  via `AGENTDOCS_URL` (default `https://agentdocs.eu`). It sends your API token
  in the `Authorization` header to that host and nowhere else.
- No telemetry, no analytics, no third-party calls.
- Treat your `AGENTDOCS_TOKEN` like a password. Prefer a **space-scoped token**
  (Space settings → Tokens) when giving an agent access to a single project —
  it cannot read or write anything outside its space.
- Tokens can be rotated at any time (account: Profile → Regenerate API Token;
  space tokens: revoke from Space settings).
