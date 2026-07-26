import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  /**
   * Raw credential, sent as `Authorization: Token <token>`. Required for the
   * stdio server, which owns exactly one credential for its whole lifetime.
   */
  token?: string;
  /**
   * Complete `Authorization` header value, used verbatim when present.
   *
   * The remote (Streamable HTTP) endpoint needs this: it serves many callers,
   * each arriving with their own header, and that header may legitimately be
   * `Bearer <jwt>` rather than `Token <api_token>`. Forwarding it unchanged
   * avoids re-deriving a scheme the caller already chose.
   */
  authHeader?: string;
  /**
   * Transport used for API calls. Defaults to the global `fetch`.
   *
   * AgentDocs' own backend hosts the remote endpoint *inside* the same process
   * that serves the REST API, and injects a dispatcher that feeds requests
   * straight into its Express app. That keeps every permission check, tier
   * limit and usage counter running in the real middleware while removing any
   * dependence on the process being able to reach itself over the network —
   * which it could not do on the production platform.
   */
  fetchImpl?: (url: URL | string, init?: RequestInit) => Promise<Response>;
}

const TOKEN_FILE = join(homedir(), ".config", "agentdocs", "token");

export function loadConfig(): Config {
  const baseUrl = (process.env.AGENTDOCS_URL ?? "https://agentdocs.eu").replace(/\/+$/, "");

  let token = process.env.AGENTDOCS_TOKEN?.trim();
  if (!token) {
    try {
      token = readFileSync(TOKEN_FILE, "utf8").trim();
    } catch {
      // fall through to the error below
    }
  }

  if (!token) {
    console.error(
      [
        "agentdocs-mcp: no API token found.",
        "",
        "Provide one via either:",
        "  - the AGENTDOCS_TOKEN environment variable (recommended for MCP client configs), or",
        `  - a token file at ${TOKEN_FILE}`,
        "",
        "Get your token at https://agentdocs.eu → Profile → Regenerate API Token",
        "(shown once at generation — save it immediately).",
        "",
        "Example (Claude Code):",
        "  claude mcp add agentdocs --env AGENTDOCS_TOKEN=<token> -- npx -y agentdocs-mcp",
      ].join("\n")
    );
    process.exit(1);
  }

  return { baseUrl, token };
}
