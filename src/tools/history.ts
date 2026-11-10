import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { safe, textResult } from "../context.js";
import { isUuid } from "../resolve.js";

/** A page_versions row as the REST API returns it (pv.* plus author_name). */
interface VersionRow {
  version: number;
  created_at: string;
  author_name?: string | null;
  edited_via?: string | null;
  token_name?: string | null;
  content?: string | null;
}

interface PageRow {
  id: string;
  title: string;
  slug: string;
  space_id?: string;
  parent_page_id?: string | null;
  version?: number;
}

const DEFAULT_VERSION_LIMIT = 50;
const MAX_VERSION_LIMIT = 200;

/** Who made a version and through what, without its text. */
function versionSummary(v: VersionRow) {
  return {
    version: v.version,
    created_at: v.created_at,
    author_name: v.author_name ?? null,
    edited_via: v.edited_via ?? null,
    token_name: v.token_name ?? null,
    content_length: (v.content ?? "").length,
  };
}

export function registerHistoryTools(server: McpServer, ctx: ToolContext): void {
  const { client, resolver } = ctx;

  server.registerTool(
    "list_page_versions",
    {
      title: "List page versions",
      description:
        "List a page's saved versions, newest first: version number, date, author, which app made the edit (edited_via: web, api_token, space_token or oauth; token_name: the token or app name) and the text length. The text itself is left out; read one version with get_page_version. Several saves by the same author through the same app within 10 minutes share one entry, so version numbers can skip.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_VERSION_LIMIT)
          .optional()
          .describe(`How many of the newest versions to return (default ${DEFAULT_VERSION_LIMIT}, max ${MAX_VERSION_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ page, limit }: { page: string; limit?: number }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request<{ versions: VersionRow[] }>("GET", `/api/pages/${pageId}/versions`);
      // The REST route returns every version with its full text. Summarise
      // here so a long, often-edited page does not flood the model's context.
      const all = [...(result.versions ?? [])].sort((a, b) => b.version - a.version);
      const take = limit ?? DEFAULT_VERSION_LIMIT;
      return textResult({
        page_id: pageId,
        total: all.length,
        versions: all.slice(0, take).map(versionSummary),
      });
    })
  );

  server.registerTool(
    "get_page_version",
    {
      title: "Get page version",
      description:
        "Read the full Markdown text of one earlier version of a page, with its author and which app made it. Find version numbers with list_page_versions. Page titles are not versioned, so only the text is returned.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        version: z.number().int().min(1).describe("Version number, from list_page_versions"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ page, version }: { page: string; version: number }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request<{ version: VersionRow }>("GET", `/api/pages/${pageId}/versions/${version}`);
      const v = result.version;
      return textResult({
        page_id: pageId,
        version: {
          version: v.version,
          created_at: v.created_at,
          author_name: v.author_name ?? null,
          edited_via: v.edited_via ?? null,
          token_name: v.token_name ?? null,
          content: v.content ?? "",
        },
      });
    })
  );

  server.registerTool(
    "restore_page_version",
    {
      title: "Restore page version",
      description:
        "Replace a page's text with the text of an earlier version. The restore is saved as a new version, and the text it replaces stays in the history as its own version, so nothing is lost and a restore can itself be undone. Only the text is restored; the title stays as it is.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        version: z.number().int().min(1).describe("Version number to restore, from list_page_versions"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ page, version }: { page: string; version: number }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request<{ page: PageRow; restored_from_version: number }>(
        "POST",
        `/api/pages/${pageId}/restore/${version}`
      );
      const p = result.page;
      return textResult({
        page: { id: p.id, title: p.title, slug: p.slug, version: p.version },
        restored_from_version: result.restored_from_version,
      });
    })
  );

  server.registerTool(
    "list_trash",
    {
      title: "List trash",
      description:
        "List the deleted pages in a space that can still be restored, most recently deleted first. Each entry is a page that was deleted directly; descendant_count says how many of its child pages went with it and come back with it. Pages stay in the trash for retention_days, then they are deleted for good. Restore one with restore_page and its id. With a space-scoped token, omit \"space\" to use the token's space.",
      inputSchema: {
        space: z
          .string()
          .optional()
          .describe('Space UUID or "workspaceSlug/spaceSlug" path. Optional for space-scoped tokens.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ space }: { space?: string }) => {
      const spaceId = await resolver.spaceId(space);
      const result = await client.request<{
        pages: Array<PageRow & { deleted_at: string; deleted_by_name?: string | null; descendant_count?: number }>;
        retention_days: number;
      }>("GET", `/api/spaces/${spaceId}/trash`);
      return textResult({
        retention_days: result.retention_days,
        pages: (result.pages ?? []).map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug,
          parent_page_id: p.parent_page_id ?? null,
          deleted_at: p.deleted_at,
          deleted_by_name: p.deleted_by_name ?? null,
          descendant_count: p.descendant_count ?? 0,
        })),
      });
    })
  );

  server.registerTool(
    "restore_page",
    {
      title: "Restore page",
      description:
        "Bring a deleted page back from the trash, with the child pages that were deleted with it. Takes the page's UUID from list_trash: deleted pages can't be found by their path. If the slug was taken meanwhile the page gets a new one (slug_changed), and if its parent page is still deleted it comes back at the top level of its space (reparented_to_root).",
      inputSchema: {
        page_id: z.string().describe("UUID of the deleted page, from list_trash"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ page_id }: { page_id: string }) => {
      if (!isUuid(page_id)) {
        throw new Error(`restore_page needs the page's UUID from list_trash; deleted pages can't be found by path (got "${page_id.slice(0, 100)}").`);
      }
      let result: { restored: number; page: PageRow; slug_changed: boolean; reparented_to_root: boolean };
      try {
        result = await client.request<{
          restored: number;
          page: PageRow;
          slug_changed: boolean;
          reparented_to_root: boolean;
        }>("POST", `/api/pages/${page_id}/restore`);
      } finally {
        // The restored page may take back a path, or come back under a new slug.
        resolver.forgetPages();
      }
      const p = result.page;
      return textResult({
        restored: result.restored,
        page: { id: p.id, title: p.title, slug: p.slug, space_id: p.space_id, parent_page_id: p.parent_page_id ?? null },
        slug_changed: result.slug_changed,
        reparented_to_root: result.reparented_to_root,
      });
    })
  );
}
