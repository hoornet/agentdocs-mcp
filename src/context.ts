import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentDocsClient } from "./client.js";
import type { Resolver } from "./resolve.js";

export interface CredentialInfo {
  type: "account" | "space" | "jwt";
  userName?: string;
  spaceId?: string;
  spaceName?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export interface ToolContext {
  client: AgentDocsClient;
  resolver: Resolver;
  credential: CredentialInfo;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Wrap a tool handler so thrown errors surface as readable MCP tool errors. */
export function safe<Args>(handler: (args: Args) => Promise<ToolResult>): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  };
}

export type RegisterFn = (server: McpServer, ctx: ToolContext) => void;
