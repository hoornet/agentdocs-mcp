import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { safe, textResult } from "../context.js";

interface Page {
  id: string;
  title: string;
  slug: string;
  content: string;
  version: number;
}

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  const { client, resolver } = ctx;

  server.registerTool(
    "create_page",
    {
      title: "Create page",
      description:
        "Create a Markdown page in a space. The slug is derived from the title unless given. With a space-scoped token, omit \"space\" to use the token's space.",
      inputSchema: {
        space: z
          .string()
          .optional()
          .describe('Space UUID or "workspaceSlug/spaceSlug" path. Optional for space-scoped tokens.'),
        title: z.string().min(1).describe("Page title"),
        content: z.string().describe("Markdown content"),
        parent_page_id: z.string().optional().describe("Parent page UUID, to nest this page under another"),
        slug: z.string().optional().describe("Explicit URL slug (auto-generated and deduped when omitted)"),
      },
    },
    safe(async ({ space, title, content, parent_page_id, slug }: {
      space?: string;
      title: string;
      content: string;
      parent_page_id?: string;
      slug?: string;
    }) => {
      const spaceId = await resolver.spaceId(space);
      const result = await client.request<{ page: Page }>("POST", `/api/spaces/${spaceId}/pages`, {
        title,
        content,
        ...(parent_page_id ? { parent_page_id } : {}),
        ...(slug ? { slug } : {}),
      });
      return textResult(result);
    })
  );

  server.registerTool(
    "update_page",
    {
      title: "Update page",
      description:
        "Update a page's title and/or content. Every update creates a new version (old versions stay restorable). Pass expected_version to fail instead of overwriting concurrent edits.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New full Markdown content (replaces existing content)"),
        expected_version: z
          .number()
          .int()
          .optional()
          .describe("If set and the page has moved past this version, the update is rejected"),
      },
    },
    safe(async ({ page, title, content, expected_version }: {
      page: string;
      title?: string;
      content?: string;
      expected_version?: number;
    }) => {
      if (title === undefined && content === undefined) {
        throw new Error("Nothing to update — provide title and/or content.");
      }
      const pageId = await resolver.pageId(page);

      if (expected_version !== undefined) {
        const current = await client.request<{ page: Page }>("GET", `/api/pages/${pageId}`);
        if (current.page.version !== expected_version) {
          throw new Error(
            `Version conflict: page is at version ${current.page.version}, expected ${expected_version}. ` +
              `Re-read the page with get_page and reapply your change.`
          );
        }
      }

      const result = await client.request<{ page: Page }>("PUT", `/api/pages/${pageId}`, {
        ...(title !== undefined ? { title } : {}),
        ...(content !== undefined ? { content } : {}),
      });
      return textResult(result);
    })
  );

  server.registerTool(
    "append_to_page",
    {
      title: "Append to page",
      description:
        "Append Markdown to the end of an existing page (read-modify-write; creates a new version). Ideal for logs, reports, and running notes.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        content: z.string().min(1).describe("Markdown to append"),
        separator: z.string().optional().describe('Separator inserted before the appended text (default: blank line "\\n\\n")'),
      },
    },
    safe(async ({ page, content, separator }: { page: string; content: string; separator?: string }) => {
      const pageId = await resolver.pageId(page);
      const current = await client.request<{ page: Page }>("GET", `/api/pages/${pageId}`);
      const existing = current.page.content ?? "";
      const sep = separator ?? "\n\n";
      const merged = existing ? `${existing}${sep}${content}` : content;
      const result = await client.request<{ page: Page }>("PUT", `/api/pages/${pageId}`, { content: merged });
      return textResult({
        page: { id: result.page.id, title: result.page.title, slug: result.page.slug, version: result.page.version },
        appended_chars: content.length,
      });
    })
  );

  server.registerTool(
    "delete_page",
    {
      title: "Delete page",
      description:
        "Permanently delete a page. WARNING: deletion cascades to all child pages. There is no undo via the API.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
      },
    },
    safe(async ({ page }: { page: string }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request("DELETE", `/api/pages/${pageId}`);
      return textResult(result);
    })
  );

  server.registerTool(
    "import_markdown",
    {
      title: "Import a markdown folder",
      description:
        "Import a folder of Markdown files and let the folder structure become the page hierarchy. Each file is { path, content } where path is a relative file path like \"guides/setup.md\". Folders become parent pages; an index.md or README.md inside a folder supplies that folder page's content; titles come from the first # H1, falling back to the file name. Ideal for an Obsidian vault, a Notion markdown export, or a repo's docs/ folder. Up to 500 files. Use bulk_create_pages instead when you want to specify the page tree explicitly. With a space-scoped token, omit \"space\" to use the token's space.",
      inputSchema: {
        space: z
          .string()
          .optional()
          .describe('Space UUID or "workspaceSlug/spaceSlug" path. Optional for space-scoped tokens.'),
        files: z
          .array(
            z.object({
              path: z.string().min(1).describe('Relative file path, e.g. "guides/setup.md" (only .md / .markdown)'),
              content: z.string().describe("Markdown file contents"),
            })
          )
          .min(1)
          .max(500)
          .describe("The markdown files to import"),
      },
    },
    safe(async ({ space, files }: { space?: string; files: Array<{ path: string; content: string }> }) => {
      const spaceId = await resolver.spaceId(space);
      const result = await client.request<{ created: number; pages: Page[] }>(
        "POST",
        `/api/spaces/${spaceId}/import/markdown`,
        { files }
      );
      return textResult({
        created: result.created,
        pages: (result.pages ?? []).map((p) => ({ id: p.id, title: p.title, slug: p.slug })),
      });
    })
  );

  server.registerTool(
    "bulk_create_pages",
    {
      title: "Bulk create pages",
      description:
        "Create up to 500 pages in one atomic call (all succeed or all fail) with an explicitly specified structure (titles, slugs, parent_page_id). To import a folder of Markdown files and derive the hierarchy from file paths, use import_markdown instead. With a space-scoped token, omit \"space\" to use the token's space.",
      inputSchema: {
        space: z
          .string()
          .optional()
          .describe('Space UUID or "workspaceSlug/spaceSlug" path. Optional for space-scoped tokens.'),
        pages: z
          .array(
            z.object({
              title: z.string().min(1),
              content: z.string(),
              slug: z.string().optional(),
              parent_page_id: z.string().optional(),
            })
          )
          .min(1)
          .max(500)
          .describe("Pages to create"),
      },
    },
    safe(async ({ space, pages }: {
      space?: string;
      pages: Array<{ title: string; content: string; slug?: string; parent_page_id?: string }>;
    }) => {
      const spaceId = await resolver.spaceId(space);
      const result = await client.request<{ created: number; pages: Page[] }>(
        "POST",
        `/api/spaces/${spaceId}/pages/bulk`,
        { pages }
      );
      return textResult({
        created: result.created,
        pages: (result.pages ?? []).map((p) => ({ id: p.id, title: p.title, slug: p.slug })),
      });
    })
  );
}
