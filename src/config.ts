import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  token: string;
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
