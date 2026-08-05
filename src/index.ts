#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AgentDocsClient, ApiError } from "./client.js";
import { Resolver } from "./resolve.js";
import type { CredentialInfo, ToolContext } from "./context.js";
import { createMcpServer } from "./lib.js";

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

  // Probe the credential to learn its scope — a space-scoped token hides the
  // workspace-level tools — but NEVER refuse to start over it. The MCP
  // handshake and tools/list carry no credential of their own, and automated
  // clients depend on that: registry indexers (Glama, docker/mcp-registry's
  // `build --tools`) boot the server with a placeholder token purely to
  // enumerate its tools. Exiting here made this server un-inspectable by all
  // of them — it had to ship a hand-maintained tools.json to compensate.
  //
  // So on a bad or unreachable credential we log, assume the full tool
  // surface, and let the first actual tool call return the real API error.
  // The diagnosis the old fail-fast provided is preserved, just deferred to
  // the point where it costs nothing.
  let credential: CredentialInfo = { type: "account" };
  try {
    credential = await detectCredential(client);
    const scopeNote =
      credential.type === "space"
        ? ` (space-scoped: ${credential.spaceName ?? credential.spaceId} in ${credential.workspaceName ?? "?"})`
        : ` (${credential.type} credential)`;
    console.error(`agentdocs-mcp v${VERSION}: connected to ${config.baseUrl} as ${credential.userName ?? "unknown"}${scopeNote}`);
  } catch (err) {
    const why = err instanceof ApiError && err.status === 401 ? err.message : err instanceof Error ? err.message : String(err);
    console.error(`agentdocs-mcp v${VERSION}: could not verify the credential against ${config.baseUrl} — ${why}`);
    console.error("agentdocs-mcp: serving the full tool surface anyway; tool calls will fail until AGENTDOCS_TOKEN is valid.");
  }

  const resolver = new Resolver(client, credential.type !== "space", credential.spaceId);
  const ctx: ToolContext = { client, resolver, credential };

  const server = createMcpServer(ctx, VERSION);

  await server.connect(new StdioServerTransport());
  console.error("agentdocs-mcp: ready (stdio)");
}

main().catch((err) => {
  console.error(`agentdocs-mcp: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
