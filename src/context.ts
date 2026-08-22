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

/**
 * What the surface running these tools is physically able to do.
 *
 * `localFiles` is a SECURITY gate, not a convenience flag. registerAllTools is
 * shared by the stdio binary (running on the user's own machine, where reading
 * a path they named is the whole point) and by AgentDocs' backend, which
 * registers the same tools per request on POST /mcp. A `path` argument honoured
 * there would be arbitrary file read on the production server, so the remote
 * surface MUST set this false.
 */
export interface ToolCapabilities {
  localFiles: boolean;
}

export interface ToolContext {
  client: AgentDocsClient;
  resolver: Resolver;
  credential: CredentialInfo;
  /** Defaults to no local file access — the safe assumption for a remote host. */
  capabilities?: ToolCapabilities;
}

type TextContent = { type: "text"; text: string };
/** Base64-encoded bytes, per the MCP image content block. */
type ImageContent = { type: "image"; data: string; mimeType: string };

type ToolResult = {
  content: Array<TextContent | ImageContent>;
  isError?: boolean;
};

export function textResult(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

/** A text block followed by image blocks, for tools that return both. */
export function textWithImages(data: unknown, images: ImageContent[]): ToolResult {
  return { content: [...textResult(data).content, ...images] };
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

export type { TextContent, ImageContent };

export type RegisterFn = (server: McpServer, ctx: ToolContext) => void;
