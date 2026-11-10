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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
        "Update a page's title and/or content. Earlier text stays in the page history (list_page_versions) and can be brought back with restore_page_version. Pass expected_version to fail instead of overwriting concurrent edits.",
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
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
        "Delete a page and all its child pages by moving them to the trash. They can be brought back with restore_page (find the id with list_trash) until the trash retention period ends, after which they are deleted for good.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ page }: { page: string }) => {
      const pageId = await resolver.pageId(page);
      try {
        const result = await client.request("DELETE", `/api/pages/${pageId}`);
        return textResult(result);
      } finally {
        // The page's path, and its children's, are free for new pages now.
        resolver.forgetPages();
      }
    })
  );

  server.registerTool(
    "move_page",
    {
      title: "Move page",
      description:
        "Move a page, with its child pages, under another page or to the top level of its space. Give parent_page to nest it, or top_level: true to put it at the top. To move it into another space of the same workspace, also give space; the new parent must then be in that space (or use top_level). Space-scoped tokens can only move pages within their own space.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path of the page to move'),
        parent_page: z
          .string()
          .optional()
          .describe('New parent page: UUID or "workspaceSlug/spaceSlug/pageSlug" path. Leave out with top_level: true.'),
        top_level: z
          .boolean()
          .optional()
          .describe("When true, move the page to the top level of its space (no parent). Don't combine with parent_page."),
        space: z
          .string()
          .optional()
          .describe('Destination space, only when moving to another space: UUID or "workspaceSlug/spaceSlug" path. Same workspace only.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ page, parent_page, top_level, space }: {
      page: string;
      parent_page?: string;
      top_level?: boolean;
      space?: string;
    }) => {
      if (parent_page && top_level) {
        throw new Error("Give either parent_page or top_level: true, not both.");
      }
      if (!parent_page && !top_level && !space) {
        throw new Error("Nothing to move to: give parent_page, top_level: true, or space.");
      }
      const pageId = await resolver.pageId(page);
      // An omitted parent_page_id means "keep the current parent" to the API,
      // and null means "top level"; send exactly one of those meanings.
      const parentPageId = parent_page ? await resolver.pageId(parent_page) : top_level ? null : undefined;
      const spaceId = space ? await resolver.spaceId(space) : undefined;
      let result: { page: Page & { space_id: string; parent_page_id: string | null } };
      try {
        result = await client.request<{ page: Page & { space_id: string; parent_page_id: string | null } }>(
          "PUT",
          `/api/pages/${pageId}/move`,
          {
            ...(parentPageId !== undefined ? { parent_page_id: parentPageId } : {}),
            ...(spaceId ? { space_id: spaceId } : {}),
          }
        );
      } finally {
        // A move to another space gives the page and its children new paths,
        // and frees the old ones. Cleared even on an error: a timed-out move
        // may still have happened on the server.
        resolver.forgetPages();
      }
      const p = result.page;
      return textResult({
        page: { id: p.id, title: p.title, slug: p.slug, space_id: p.space_id, parent_page_id: p.parent_page_id ?? null },
      });
    })
  );

  server.registerTool(
    "import_markdown",
    {
      title: "Import a markdown folder",
      description:
        "Import a folder of Markdown files and let the folder structure become the page hierarchy. Each file is { path, content } where path is a relative file path like \"guides/setup.md\". Folders become parent pages; an index.md or README.md inside a folder supplies that folder page's content; titles come from the first # H1, falling back to the file name. Ideal for an Obsidian vault, a Notion markdown export, or a repo's docs/ folder. Up to 500 files per call. IDEMPOTENT: pages are matched by source path, so re-running an import — or chunking a large vault across several calls — reuses existing pages instead of creating duplicates (response reports created/reused/updated counts). By default existing pages keep their content; set overwrite_existing to re-sync content from the files. Use parent_page to nest the whole import under an existing page. Use bulk_create_pages instead when you want to specify the page tree explicitly. With a space-scoped token, omit \"space\" to use the token's space.",
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
        parent_page: z
          .string()
          .optional()
          .describe('Optional existing page to nest the import under (UUID or "workspaceSlug/spaceSlug/pageSlug" path). Defaults to the space root.'),
        overwrite_existing: z
          .boolean()
          .optional()
          .describe("When true, re-importing updates the content of pages that already exist (re-sync). Default false: existing pages are left untouched."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ space, files, parent_page, overwrite_existing }: {
      space?: string;
      files: Array<{ path: string; content: string }>;
      parent_page?: string;
      overwrite_existing?: boolean;
    }) => {
      const spaceId = await resolver.spaceId(space);
      const parentId = parent_page ? await resolver.pageId(parent_page) : undefined;
      const result = await client.request<{ created: number; reused: number; updated: number; pages: Page[] }>(
        "POST",
        `/api/spaces/${spaceId}/import/markdown`,
        {
          files,
          ...(parentId ? { parent_page: parentId } : {}),
          ...(overwrite_existing ? { overwrite_existing: true } : {}),
        }
      );
      return textResult({
        created: result.created,
        reused: result.reused,
        updated: result.updated,
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
