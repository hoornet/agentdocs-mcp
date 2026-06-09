import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { safe, textResult } from "../context.js";

interface PageNode {
  id: string;
  title: string;
  slug: string;
  parent_page_id?: string | null;
  updated_at?: string;
  children?: PageNode[];
}

/** Drop page content from listings to keep tool output small. */
function trimPageTree(pages: PageNode[]): PageNode[] {
  return pages.map((page) => ({
    id: page.id,
    title: page.title,
    slug: page.slug,
    parent_page_id: page.parent_page_id ?? null,
    updated_at: page.updated_at,
    ...(page.children?.length ? { children: trimPageTree(page.children) } : {}),
  }));
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const { client, resolver, credential } = ctx;

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Identify the authenticated AgentDocs user and credential scope. Call this first: a space-scoped credential is locked to a single space, which becomes the default for page tools.",
      inputSchema: {},
    },
    safe(async () => {
      const me = await client.request("GET", "/api/auth/me");
      return textResult(me);
    })
  );

  // Workspace-scoped tools are unavailable to space tokens (they 403); hide
  // them so the client model never sees tools it cannot call.
  if (credential.type !== "space") {
    server.registerTool(
      "list_workspaces",
      {
        title: "List workspaces",
        description: "List all AgentDocs workspaces the user can access. Workspaces contain spaces; spaces contain pages.",
        inputSchema: {},
      },
      safe(async () => {
        const result = await client.request("GET", "/api/workspaces");
        return textResult(result);
      })
    );

    server.registerTool(
      "list_spaces",
      {
        title: "List spaces",
        description: "List the spaces in a workspace.",
        inputSchema: {
          workspace: z.string().describe("Workspace UUID or workspace slug (e.g. \"my-team-docs\")"),
        },
      },
      safe(async ({ workspace }: { workspace: string }) => {
        const workspaceId = await resolver.workspaceId(workspace);
        const result = await client.request("GET", `/api/workspaces/${workspaceId}/spaces`);
        return textResult(result);
      })
    );

    server.registerTool(
      "search_docs",
      {
        title: "Search docs",
        description:
          "Full-text search across all pages in a workspace. Matches in the returned content_preview are delimited with << >> markers.",
        inputSchema: {
          workspace: z.string().describe("Workspace UUID or workspace slug"),
          query: z.string().min(1).describe("Search terms"),
        },
      },
      safe(async ({ workspace, query }: { workspace: string; query: string }) => {
        const workspaceId = await resolver.workspaceId(workspace);
        const result = await client.request("GET", `/api/workspaces/${workspaceId}/search`, undefined, { q: query });
        return textResult(result);
      })
    );
  }

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "List the pages in a space as a tree (content omitted — use get_page to read a page). With a space-scoped token, omit \"space\" to use the token's space.",
      inputSchema: {
        space: z
          .string()
          .optional()
          .describe('Space UUID or "workspaceSlug/spaceSlug" path. Optional for space-scoped tokens.'),
      },
    },
    safe(async ({ space }: { space?: string }) => {
      const spaceId = await resolver.spaceId(space);
      const result = await client.request<{ pages: PageNode[] }>("GET", `/api/spaces/${spaceId}/pages`, undefined, {
        hierarchy: "true",
      });
      return textResult({ pages: trimPageTree(result.pages ?? []) });
    })
  );

  server.registerTool(
    "get_page",
    {
      title: "Get page",
      description: "Read a page including its full Markdown content and current version number.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
      },
    },
    safe(async ({ page }: { page: string }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request("GET", `/api/pages/${pageId}`);
      return textResult(result);
    })
  );
}
