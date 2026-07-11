#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AgentDocsClient, ApiError } from "./client.js";
import { Resolver } from "./resolve.js";
import type { CredentialInfo, ToolContext } from "./context.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerShareTools } from "./tools/share.js";
import { registerCommentTools } from "./tools/comments.js";

// Read from package.json rather than a literal: this is the version reported to
// every client in the MCP initialize handshake, and a hand-maintained copy had
// silently drifted two releases behind.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const VERSION = pkg.version;

interface MeResponse {
  user?: { name?: string; email?: string };
  credential?: {
    type?: string;
    space_id?: string;
    space_name?: string;
    workspace_id?: string;
    workspace_name?: string;
  };
}

async function detectCredential(client: AgentDocsClient): Promise<CredentialInfo> {
  const me = await client.request<MeResponse>("GET", "/api/auth/me");
  const type = me.credential?.type === "space" ? "space" : me.credential?.type === "jwt" ? "jwt" : "account";
  return {
    type,
    userName: me.user?.name,
    spaceId: me.credential?.space_id,
    spaceName: me.credential?.space_name,
    workspaceId: me.credential?.workspace_id,
    workspaceName: me.credential?.workspace_name,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new AgentDocsClient(config);

  // Verify the credential up front: a bad token should fail fast with a clear
  // message instead of surfacing as cryptic per-tool errors later.
  let credential: CredentialInfo;
  try {
    credential = await detectCredential(client);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.error(`agentdocs-mcp: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const scopeNote =
    credential.type === "space"
      ? ` (space-scoped: ${credential.spaceName ?? credential.spaceId} in ${credential.workspaceName ?? "?"})`
      : ` (${credential.type} credential)`;
  console.error(`agentdocs-mcp v${VERSION}: connected to ${config.baseUrl} as ${credential.userName ?? "unknown"}${scopeNote}`);

  const resolver = new Resolver(client, credential.type !== "space", credential.spaceId);
  const ctx: ToolContext = { client, resolver, credential };

  const server = new McpServer({ name: "agentdocs", version: VERSION });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerShareTools(server, ctx);
  registerCommentTools(server, ctx);

  await server.connect(new StdioServerTransport());
  console.error("agentdocs-mcp: ready (stdio)");
}

main().catch((err) => {
  console.error(`agentdocs-mcp: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
