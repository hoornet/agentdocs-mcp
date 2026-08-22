import { z } from "zod";
import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { safe, textResult } from "../context.js";

const MAX_BYTES = 5 * 1024 * 1024; // matches the server's per-file cap

/** MIME types the server accepts. SVG is excluded there (script injection). */
const SNIFFERS: Array<{ mime: string; ext: string; match: (b: Buffer) => boolean }> = [
  { mime: "image/png", ext: "png", match: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", match: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", match: b => b.subarray(0, 6).toString("ascii").startsWith("GIF8") },
  {
    mime: "image/webp",
    ext: "webp",
    match: b => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

/**
 * Identify the image from its magic bytes rather than trusting a filename.
 * The server sniffs nothing — it believes the declared Content-Type — so
 * getting this right here is what keeps a mislabelled file from being stored
 * under a type it isn't.
 */
function sniffImage(bytes: Buffer): { mime: string; ext: string } {
  const hit = SNIFFERS.find(s => s.match(bytes));
  if (!hit) {
    throw new Error(
      "Unsupported image format. AgentDocs accepts PNG, JPEG, GIF and WebP (SVG is rejected server-side as a script-injection vector)."
    );
  }
  return { mime: hit.mime, ext: hit.ext };
}

function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith("127.") || ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith("169.254.")) return true; // link-local, incl. cloud metadata
  if (/^f[cd]/i.test(ip)) return true; // IPv6 unique-local
  if (/^fe80:/i.test(ip)) return true; // IPv6 link-local
  return false;
}

/**
 * Fetch an image by URL, refusing anything that resolves to a private address.
 *
 * This matters more on the remote surface than it looks: there this code runs
 * inside AgentDocs' own backend, so an unguarded fetch would be a server-side
 * request forgery primitive pointed at the production network and its cloud
 * metadata endpoint.
 */
async function fetchImage(rawUrl: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`source_url is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("source_url must be http or https.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
  if (addresses.length === 0) throw new Error(`Could not resolve ${url.hostname}.`);
  if (addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to fetch ${url.hostname}: it resolves to a private or loopback address.`);
  }

  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Fetching ${rawUrl} failed with HTTP ${response.status}.`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    throw new Error(`Image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`);
  }
  return bytes;
}

export function registerMediaTools(server: McpServer, ctx: ToolContext): void {
  const { client, resolver } = ctx;
  const localFiles = ctx.capabilities?.localFiles === true;

  // The description differs by surface so the model is not offered an argument
  // that will be refused.
  const sources = localFiles
    ? 'Provide exactly one of "path" (a file on this machine), "source_url", or "data" (base64).'
    : 'Provide exactly one of "source_url" or "data" (base64). "path" is unavailable on the remote server — it has no access to your filesystem.';

  server.registerTool(
    "upload_image",
    {
      title: "Upload image",
      description:
        "Attach an image (PNG, JPEG, GIF or WebP; max 5 MB) to a space and get back the Markdown to embed it in a page. " +
        "Use this to include screenshots and diagrams in the pages you write, so whoever reads the page later — human or agent — can see what you saw. " +
        sources +
        " Counts against the workspace's storage quota.",
      inputSchema: {
        space: z
          .string()
          .optional()
          .describe('Space UUID or "workspaceSlug/spaceSlug" path. Optional for space-scoped tokens.'),
        path: z
          .string()
          .optional()
          .describe(
            localFiles
              ? "Absolute path to an image file on this machine."
              : "Not supported on the remote server; use source_url or data."
          ),
        source_url: z.string().optional().describe("Public http(s) URL to fetch the image from."),
        data: z.string().optional().describe("Base64-encoded image bytes."),
        filename: z.string().optional().describe("Original filename to record (cosmetic; defaults to image.<ext>)."),
        alt_text: z.string().optional().describe("Alt text for the returned Markdown snippet."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ space, path, source_url, data, filename, alt_text }: {
      space?: string;
      path?: string;
      source_url?: string;
      data?: string;
      filename?: string;
      alt_text?: string;
    }) => {
      const given = [path, source_url, data].filter(v => v !== undefined && v !== "");
      if (given.length === 0) {
        throw new Error(`No image source given. ${sources}`);
      }
      if (given.length > 1) {
        throw new Error("Give only one of path, source_url or data.");
      }

      let bytes: Buffer;
      if (path !== undefined && path !== "") {
        if (!localFiles) {
          throw new Error(
            "This AgentDocs server cannot read files from your machine — it is a remote HTTP endpoint. " +
              "Pass the image as base64 via `data`, or host it and pass `source_url`."
          );
        }
        bytes = await readFile(path);
        if (bytes.length > MAX_BYTES) {
          throw new Error(`Image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`);
        }
      } else if (source_url !== undefined && source_url !== "") {
        bytes = await fetchImage(source_url);
      } else {
        bytes = Buffer.from(data as string, "base64");
        if (bytes.length === 0) throw new Error("data did not decode to any bytes — is it valid base64?");
        if (bytes.length > MAX_BYTES) {
          throw new Error(`Image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`);
        }
      }

      const { mime, ext } = sniffImage(bytes);
      const spaceId = await resolver.spaceId(space);
      const name = filename || (path ? path.split(/[\\/]/).pop() : undefined) || `image.${ext}`;

      const result = await client.uploadFile<{ url: string; id: string; filename: string; size_bytes: number }>(
        `/api/spaces/${spaceId}/uploads`,
        { bytes, filename: name, mimeType: mime }
      );

      const absolute = `${client.baseUrl}${result.url}`;
      return textResult({
        ...result,
        absolute_url: absolute,
        markdown: `![${alt_text || name}](${result.url})`,
        next_step:
          "Paste the `markdown` value into a page (create_page / update_page / append_to_page) to display the image there.",
      });
    })
  );
}
