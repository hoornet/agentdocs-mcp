/**
 * Library entry point.
 *
 * The stdio binary (`src/index.ts`) is one consumer of this module; the other
 * is AgentDocs' own backend, which mounts a remote Streamable HTTP endpoint at
 * POST /mcp and registers these same tools per request. Keeping the tool
 * definitions here — and exporting them rather than copying them — is what
 * stops the stdio and remote surfaces from drifting apart.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerShareTools } from "./tools/share.js";
import { registerCommentTools } from "./tools/comments.js";

export { AgentDocsClient, ApiError } from "./client.js";
export { Resolver, isUuid } from "./resolve.js";
export type { Config } from "./config.js";
export type { CredentialInfo, ToolContext } from "./context.js";

/** Register the full AgentDocs tool set on an MCP server instance. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerShareTools(server, ctx);
  registerCommentTools(server, ctx);
}

/**
 * Build a ready-to-serve MCP server for one caller.
 *
 * Remote callers MUST get their own instance per request: `Resolver` caches
 * slug -> UUID with no user dimension (see resolve.ts), so a shared instance
 * would let one tenant's resolutions answer another's lookups.
 */
export function createMcpServer(ctx: ToolContext, version: string): McpServer {
  const server = new McpServer({ name: "agentdocs", version });
  registerAllTools(server, ctx);
  return server;
}
