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
  comment_count?: number;
  unresolved_comment_count?: number;
  last_comment_at?: string | null;
  children?: PageNode[];
}

/**
 * Drop page content from listings to keep tool output small. Comment stats are
 * kept (when non-zero) — comments don't bump updated_at, so they are the only
 * listing-level signal that a page has a discussion to read.
 */
function trimPageTree(pages: PageNode[]): PageNode[] {
  return pages.map((page) => ({
    id: page.id,
    title: page.title,
    slug: page.slug,
    parent_page_id: page.parent_page_id ?? null,
    updated_at: page.updated_at,
    ...(page.comment_count
      ? {
          comment_count: page.comment_count,
          unresolved_comment_count: page.unresolved_comment_count,
          last_comment_at: page.last_comment_at,
        }
      : {}),
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
          "Full-text (keyword) search across all pages in a workspace. Matches in the returned content_preview are delimited with << >> markers. For natural-language questions, prefer semantic_search.",
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

    server.registerTool(
      "semantic_search",
      {
        title: "Semantic search",
        description:
          "Search a workspace by meaning, not keywords — ask a natural-language question (e.g. \"how do we handle billing retries?\") and get the most relevant pages ranked by similarity. Pages are embedded automatically after each save. Requires a Pro workspace; the response 'mode' is \"semantic\" when active, or \"fulltext_fallback\" if semantic search is not configured on the instance (results are still returned).",
        inputSchema: {
          workspace: z.string().describe("Workspace UUID or workspace slug"),
          query: z.string().min(1).max(1000).describe("A natural-language question or description (max 1000 chars)"),
        },
      },
      safe(async ({ workspace, query }: { workspace: string; query: string }) => {
        const workspaceId = await resolver.workspaceId(workspace);
        const result = await client.request("GET", `/api/workspaces/${workspaceId}/search`, undefined, {
          q: query,
          mode: "semantic",
        });
        return textResult(result);
      })
    );
  }

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "List the pages in a space as a tree (content omitted — use get_page to read a page). Pages with a discussion carry comment_count / unresolved_comment_count / last_comment_at — comments do NOT bump a page's updated_at, so check last_comment_at to spot new replies. With a space-scoped token, omit \"space\" to use the token's space.",
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
      description:
        "Read a page including its full Markdown content and current version number. The page carries comment_count / unresolved_comment_count / last_comment_at — if comment_count > 0 there is a discussion; set include_comments to read it. include_children returns the page's child pages (titles + slugs, no content) — useful for 'folder' pages whose own content is empty but which organise sub-pages.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        include_comments: z
          .boolean()
          .optional()
          .describe("When true, also return the page's comments (threaded) alongside the page."),
        include_children: z
          .boolean()
          .optional()
          .describe("When true, also return the page's immediate child pages (id, title, slug — no content)."),
      },
    },
    safe(async ({ page, include_comments, include_children }: {
      page: string;
      include_comments?: boolean;
      include_children?: boolean;
    }) => {
      const pageId = await resolver.pageId(page);
      const include = [include_comments && "comments", include_children && "children"]
        .filter(Boolean)
        .join(",");
      const result = await client.request(
        "GET",
        `/api/pages/${pageId}`,
        undefined,
        include ? { include } : undefined
      );
      return textResult(result);
    })
  );
}
