import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { safe, textResult } from "../context.js";
import { isUuid } from "../resolve.js";

interface Comment {
  id: string;
  content: string;
  author_name?: string;
  parent_comment_id?: string | null;
  resolved?: boolean;
}

/**
 * Comments have no slug path — they are addressed by UUID only. (Resolve a
 * page to find its comment IDs with get_page include_comments / list_comments.)
 */
function requireCommentId(comment: string): string {
  if (!isUuid(comment)) {
    throw new Error(
      `Invalid comment id "${comment}" — comments are addressed by UUID only. ` +
        `Use get_page with include_comments (or list_comments) to find a comment's id.`
    );
  }
  return comment;
}

export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  const { client, resolver } = ctx;

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "List the threaded comments on a page, returning each comment's id, content, author and parent. Use this to find a comment's id before update_comment / delete_comment. (get_page with include_comments returns the same thread alongside the page content.)",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
      },
    },
    safe(async ({ page }: { page: string }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request("GET", `/api/pages/${pageId}/comments`);
      return textResult(result);
    })
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description:
        "Post a comment on a page. Set parent_comment_id to reply within an existing thread. Mentioning a user with @name notifies them; the returned 'mentions' array lists who was matched.",
      inputSchema: {
        page: z.string().describe('Page UUID or "workspaceSlug/spaceSlug/pageSlug" path'),
        content: z.string().min(1).max(10000).describe("Comment body (Markdown; supports @mentions)"),
        parent_comment_id: z
          .string()
          .optional()
          .describe("UUID of the comment being replied to, to thread under it (omit for a top-level comment)"),
      },
    },
    safe(async ({ page, content, parent_comment_id }: {
      page: string;
      content: string;
      parent_comment_id?: string;
    }) => {
      const pageId = await resolver.pageId(page);
      const result = await client.request<{ comment: Comment; mentions: unknown[] }>(
        "POST",
        `/api/pages/${pageId}/comments`,
        {
          content,
          ...(parent_comment_id ? { parent_comment_id: requireCommentId(parent_comment_id) } : {}),
        }
      );
      return textResult(result);
    })
  );

  server.registerTool(
    "update_comment",
    {
      title: "Update comment",
      description:
        "Edit a comment's body and/or mark its thread resolved. Only the comment's author (or an admin) may update it. Provide at least one of content / resolved.",
      inputSchema: {
        comment: z.string().describe("Comment UUID (from get_page include_comments or list_comments)"),
        content: z.string().min(1).max(10000).optional().describe("New comment body (replaces the existing text)"),
        resolved: z.boolean().optional().describe("Mark the comment thread resolved (true) or reopen it (false)"),
      },
    },
    safe(async ({ comment, content, resolved }: {
      comment: string;
      content?: string;
      resolved?: boolean;
    }) => {
      if (content === undefined && resolved === undefined) {
        throw new Error("Nothing to update — provide content and/or resolved.");
      }
      const commentId = requireCommentId(comment);
      const result = await client.request<{ comment: Comment }>("PUT", `/api/comments/${commentId}`, {
        ...(content !== undefined ? { content } : {}),
        ...(resolved !== undefined ? { resolved } : {}),
      });
      return textResult(result);
    })
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete comment",
      description:
        "Permanently delete a comment. Only the comment's author (or an admin) may delete it. There is no undo via the API.",
      inputSchema: {
        comment: z.string().describe("Comment UUID (from get_page include_comments or list_comments)"),
      },
    },
    safe(async ({ comment }: { comment: string }) => {
      const commentId = requireCommentId(comment);
      const result = await client.request("DELETE", `/api/comments/${commentId}`);
      return textResult(result);
    })
  );
}
