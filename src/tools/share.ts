import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { safe, textResult } from "../context.js";

interface ShareLink {
  id: string;
  token: string;
  url: string;
  expires_at: string | null;
  created_at: string;
}

export function registerShareTools(server: McpServer, ctx: ToolContext): void {
  const { client, resolver } = ctx;

  server.registerTool(
    "share_page",
    {
      title: "Share page",
      description:
        "Create a public magic link for a page — anyone with the link can read it without logging in. Returns a web URL and a raw-Markdown URL (the raw one is ideal for other agents).",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        expires_in_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Days until the link expires. Omit for a non-expiring link."),
      },
    },
    safe(async ({ page, expires_in_days }: { page: string; expires_in_days?: number }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request<{ share_link: ShareLink }>("POST", `/api/pages/${pageId}/share`, {
        ...(expires_in_days !== undefined ? { expires_in_days } : {}),
      });
      const link = result.share_link;
      // The API returns a relative url — return absolute URLs so they are directly usable.
      return textResult({
        share_link: {
          id: link.id,
          url: `${client.baseUrl}${link.url}`,
          raw_markdown_url: `${client.baseUrl}/api/shared/${link.token}/raw`,
          expires_at: link.expires_at,
          created_at: link.created_at,
        },
      });
    })
  );
}
