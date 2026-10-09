import { z } from "zod";
import { readFile } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { safe, textResult } from "../context.js";

const MAX_BYTES = 5 * 1024 * 1024; // matches the server's per-file cap
const FETCH_TIMEOUT_MS = 20_000;

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
      "Unsupported image format: these bytes are not a PNG, JPEG, GIF or WebP. " +
        "(SVG is rejected as a script-injection vector.) If you passed base64, check it is the encoding of the image FILE'S BYTES — " +
        "text, a data: URI with a non-image type, or an HTML page will all land here."
    );
  }
  return { mime: hit.mime, ext: hit.ext };
}

// Address ranges source_url must never reach. net.BlockList does the subnet
// math, and auto-promotes IPv4 input to its IPv4-mapped form, so `::ffff:…`
// spellings of a blocked IPv4 are caught by the IPv4 rules below. (Do NOT add
// ::ffff:0:0/96 as a subnet — that same promotion would then block every
// public IPv4 address.) This mirrors AgentDocs' server-side guard.
const blockList = new BlockList();
blockList.addSubnet("0.0.0.0", 8, "ipv4");       // "this host" / unspecified
blockList.addSubnet("10.0.0.0", 8, "ipv4");      // RFC1918 private
blockList.addSubnet("100.64.0.0", 10, "ipv4");   // RFC6598 carrier-grade NAT
blockList.addSubnet("127.0.0.0", 8, "ipv4");     // loopback
blockList.addSubnet("169.254.0.0", 16, "ipv4");  // link-local, incl. cloud metadata
blockList.addSubnet("172.16.0.0", 12, "ipv4");   // RFC1918 private
blockList.addSubnet("192.0.0.0", 24, "ipv4");    // IETF protocol assignments
blockList.addSubnet("192.168.0.0", 16, "ipv4");  // RFC1918 private
blockList.addSubnet("198.18.0.0", 15, "ipv4");   // benchmarking (RFC2544)
blockList.addSubnet("224.0.0.0", 4, "ipv4");     // multicast
blockList.addSubnet("240.0.0.0", 4, "ipv4");     // reserved, incl. broadcast
blockList.addAddress("::", "ipv6");              // unspecified
blockList.addAddress("::1", "ipv6");             // loopback
blockList.addSubnet("fc00::", 7, "ipv6");        // unique local
blockList.addSubnet("fe80::", 10, "ipv6");       // link-local
blockList.addSubnet("fec0::", 10, "ipv6");       // site-local (deprecated, still routed by some stacks)
blockList.addSubnet("ff00::", 8, "ipv6");        // multicast
blockList.addSubnet("100::", 64, "ipv6");        // discard-only
// IPv4-embedding transition ranges: where NAT64 / 6to4 / Teredo routing exists,
// 64:ff9b::7f00:1 IS 127.0.0.1. Harmless to block elsewhere.
blockList.addSubnet("::", 96, "ipv6");           // IPv4-compatible (deprecated) — ::7f00:1
blockList.addSubnet("64:ff9b::", 96, "ipv6");    // NAT64 well-known prefix
blockList.addSubnet("64:ff9b:1::", 48, "ipv6");  // NAT64 local-use prefix
blockList.addSubnet("2002::", 16, "ipv6");       // 6to4
blockList.addSubnet("2001::", 32, "ipv6");       // Teredo

/** True when `ip` is an address literal inside a blocked range. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return blockList.check(ip, family === 4 ? "ipv4" : "ipv6");
}

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;
/** The `lookup` shape net.connect / http.request accept. */
export type LookupFn = (hostname: string, options: unknown, callback: LookupCallback) => void;

const PRIVATE_ADDRESS_MESSAGE = (hostname: string) =>
  `Refusing to fetch ${hostname}: it resolves to a private or loopback address.`;

/**
 * A `lookup` for http.request that refuses any answer inside the blocked
 * ranges. Validating at CONNECT time is what closes the DNS-rebinding gap:
 * checking the addresses first and then letting fetch resolve the name again
 * on its own meant a TTL-0 record could pass the check and connect somewhere
 * internal. `base` is injectable so the guard is testable without real DNS.
 */
export function makeGuardedLookup(base: LookupFn = dnsLookup as unknown as LookupFn): LookupFn {
  return (hostname, options, callback) => {
    base(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);
      const answers: LookupAddress[] = Array.isArray(address) ? address : [{ address, family: family ?? 0 }];
      if (answers.some(a => isPrivateAddress(a.address))) {
        return callback(new Error(PRIVATE_ADDRESS_MESSAGE(hostname)), address, family);
      }
      callback(null, address, family);
    });
  };
}

const guardedLookup = makeGuardedLookup();

export interface FetchImageOptions {
  /** Test seam only — production always uses the guarded lookup. */
  lookup?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
}

// Ports the Fetch spec refuses ("bad ports": SMTP, IRC, X11, …). fetch() used
// to give us this for free; http.request connects anywhere, and a tool that
// runs from AgentDocs' own IP must not become a port probe against the hosts
// it is pointed at — so refuse the same list, and keep transport errors
// generic below for the same reason.
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

// A 5 MB body can arrive as five million 1-byte HTTP chunks (~31 MB on the
// wire). Byte-counting alone would accept that — and keeping one Buffer object
// per chunk was measured at ~1 GB of heap for exactly that input. Bytes are
// therefore copied into ONE preallocated buffer, and a response fragmented
// beyond any plausible image transfer is refused outright to bound the CPU
// spent parsing it. A 5 MB image in 1.4 KB TCP segments is ~3,600 events.
const MAX_BODY_EVENTS = 65_536;

/**
 * Fetch an image by URL, refusing anything that resolves to a private address
 * and never holding more than `maxBytes` of the response in memory.
 *
 * This matters more on the remote surface than it looks: there this code runs
 * inside AgentDocs' own backend, so an unguarded fetch would be a server-side
 * request forgery primitive pointed at the production network and its cloud
 * metadata endpoint — and an unbounded read would let one `source_url` aimed
 * at a receiver that streams gigabytes exhaust the single process that serves
 * every tenant. The earlier implementation checked DNS, then let global fetch
 * resolve the name again on its own, and buffered the whole body with
 * `arrayBuffer()` before comparing it to the 5 MB cap; this one validates the
 * address the socket is about to use and stops reading at the cap.
 *
 * Redirects are not followed (http.request never does; a 3xx is an error),
 * matching the previous `redirect: "error"`.
 */
export function fetchImage(rawUrl: string, opts: FetchImageOptions = {}): Promise<Buffer> {
  const { lookup = guardedLookup, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = opts;
  const limitMb = (maxBytes / 1024 / 1024).toFixed(maxBytes % (1024 * 1024) === 0 ? 0 : 1);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.reject(new Error(`source_url is not a valid URL: ${rawUrl}`));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Promise.reject(new Error("source_url must be http or https."));
  }
  if (url.username !== "" || url.password !== "") {
    // fetch() refused these too; http.request would send them as Basic auth.
    return Promise.reject(new Error("source_url must not contain credentials."));
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (BAD_PORTS.has(port)) {
    return Promise.reject(new Error(`Refusing to fetch ${url.hostname}: port ${port} is not an HTTP port.`));
  }

  // net.connect skips `lookup` when the host is already an IP literal, so the
  // guarded lookup never sees http://169.254.169.254/ — check literals here.
  // URL.hostname keeps the brackets around IPv6 literals; strip them.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(new Error(PRIVATE_ADDRESS_MESSAGE(url.hostname)));
  }

  const tooBig = (sizeBytes?: number) =>
    new Error(
      sizeBytes === undefined
        ? `Image is larger than ${limitMb} MB (download stopped at the limit); the limit is ${limitMb} MB.`
        : `Image is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${limitMb} MB.`
    );

  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const ok = (bytes: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(bytes);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const req = request(url, {
      method: "GET",
      // http.request's option type names Node's own dns.lookup signature; the
      // guarded function is call-compatible with how net.connect invokes it.
      lookup: lookup as unknown as typeof dnsLookup,
      // No shared keep-alive pool: the global agent keys sockets by host:port
      // only, so a socket another caller opened to this host with a different
      // lookup could be handed to us having never passed the guard.
      agent: false,
      headers: { Accept: "image/*", "Accept-Encoding": "identity" },
    });

    // One deadline for the whole exchange — connect, headers AND body. Settle
    // FIRST: req.destroy() is a no-op on an already-destroyed request (e.g.
    // after a 101 reply, which Node answers by destroying the socket without
    // ever emitting 'response' or 'error'), so relying on it to surface the
    // timeout would leave the promise pending forever.
    const timer = setTimeout(() => {
      const err = new Error(`Fetching ${rawUrl} timed out after ${timeoutMs} ms.`);
      fail(err);
      req.destroy(err);
    }, timeoutMs);

    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        return fail(new Error(`Fetching ${rawUrl} failed: it redirects (HTTP ${status}) and redirects are not followed.`));
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        return fail(new Error(`Fetching ${rawUrl} failed with HTTP ${status}.`));
      }

      // Cheap reject before reading a byte when the sender declares the size.
      const declared = Number(res.headers["content-length"]);
      const hasDeclared = Number.isFinite(declared) && declared >= 0;
      if (hasDeclared && declared > maxBytes) {
        res.destroy();
        return fail(tooBig(declared));
      }

      // One buffer, sized to the declared length when known, grown only as far
      // as the cap. Chunks are COPIED in and dropped — see MAX_BODY_EVENTS.
      let buf = Buffer.allocUnsafe(hasDeclared ? declared : Math.min(64 * 1024, maxBytes));
      let received = 0;
      let events = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        events += 1;
        if (received + chunk.length > maxBytes) {
          res.destroy();
          return fail(tooBig());
        }
        if (events > MAX_BODY_EVENTS) {
          res.destroy();
          return fail(new Error(`Fetching ${rawUrl} failed: the response is fragmented into too many pieces to be an image.`));
        }
        if (received + chunk.length > buf.length) {
          const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(buf.length * 2, received + chunk.length)));
          buf.copy(grown, 0, 0, received);
          buf = grown;
        }
        chunk.copy(buf, received);
        received += chunk.length;
      });
      res.on("end", () => ok(buf.subarray(0, received)));
      res.on("error", (err: Error) => fail(err));
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
        return fail(new Error(`Could not resolve ${url.hostname}.`));
      }
      if (err.message.includes("private or loopback")) return fail(err);
      // Deliberately vague: "ECONNREFUSED 93.184.216.34:8080" would turn this
      // tool into a port scanner run from the server's address.
      fail(new Error(`Could not fetch ${rawUrl}: the connection failed.`));
    });
    // Safety net for every way a request can end without 'response' or
    // 'error' (a 101 reply is one). No-op once settled.
    req.on("close", () => fail(new Error(`Fetching ${rawUrl} failed: the connection closed before a complete response.`)));
    req.end();
  });
}

export function registerMediaTools(server: McpServer, ctx: ToolContext): void {
  const { client, resolver } = ctx;
  const localFiles = ctx.capabilities?.localFiles === true;

  // The description differs by surface so the model is not offered an argument
  // that will be refused.
  // Written for an agent that HAS a screenshot and does not know how to hand it
  // over. The failure this prevents is real: a model that merely *viewed* an
  // image (a screenshot returned by another tool) cannot re-encode it — it saw
  // pixels, not bytes — and will otherwise try to invent base64, or give up.
  const sources = localFiles
    ? 'HOW TO SUPPLY THE IMAGE — give exactly one of:\n' +
      '  • path — absolute path to an image file on this machine. Prefer this: the bytes never pass through the conversation.\n' +
      '  • data — base64 of the file\'s bytes (a "data:image/png;base64,..." URI is also accepted).\n' +
      '  • source_url — a public http(s) URL; the server fetches it.\n' +
      'If you can only SEE an image (e.g. a screenshot another tool returned), you cannot re-encode it from what you see — you need the file. Save it to disk, then pass its "path".'
    : 'HOW TO SUPPLY THE IMAGE — give exactly one of:\n' +
      '  • data — base64 of the file\'s bytes (a "data:image/png;base64,..." URI is also accepted).\n' +
      '  • source_url — a public http(s) URL; the server fetches it.\n' +
      '"path" does NOT work here: this is a remote HTTP server with no access to your filesystem.\n' +
      'If you can only SEE an image (e.g. a screenshot another tool returned), you cannot re-encode it from what you see — you need the actual file bytes. If you have shell/file access, read the file and base64 it; otherwise host it somewhere reachable and use "source_url".';

  server.registerTool(
    "upload_image",
    {
      title: "Upload image",
      description:
        "Attach an image to a space and get back the Markdown to embed it in a page. " +
        "Use this to put screenshots and diagrams into the pages you write, so whoever reads the page later — human or agent — can see what you saw. " +
        "ACCEPTS: PNG, JPEG, GIF, WebP. Max 5 MB. SVG is rejected (script-injection vector). The format is detected from the file's own bytes, not its name. " +
        sources +
        " Counts against the workspace's image storage quota (Free 50 MB, Pro 5 GB).",
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
              ? "Absolute path to an image file on this machine. Best option — the bytes never enter the conversation."
              : "NOT SUPPORTED on this remote server (it cannot read your filesystem). Use data or source_url."
          ),
        source_url: z
          .string()
          .optional()
          .describe("Public http(s) URL the server fetches the image from. Must be publicly reachable — private/loopback addresses are refused."),
        data: z
          .string()
          .optional()
          .describe("Base64 of the image FILE'S BYTES (a \"data:image/png;base64,...\" URI is accepted too). Not a description of the image, and not something you can produce from an image you only viewed."),
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
        // Strip a data: URI wrapper if present. Agents reach for
        // "data:image/png;base64,AAA..." naturally, and feeding that whole
        // string to Buffer.from would decode to garbage and then fail the
        // format sniff with a misleading "unsupported format" error.
        const payload = (data as string).replace(/^data:[^;,]*;base64,/, "").trim();
        bytes = Buffer.from(payload, "base64");
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

      // No absolute_url: on the remote surface client.baseUrl is a synthetic
      // self-base that nothing dials (see AgentDocs' in-process dispatch), so
      // it renders as http://127.0.0.1:3000/... — a URL an agent would follow
      // and fail on. The relative url is what belongs in a page anyway.
      return textResult({
        ...result,
        markdown: `![${alt_text || name}](${result.url})`,
        next_step:
          "Paste the `markdown` value into a page (create_page / update_page / append_to_page) to display the image there.",
      });
    })
  );
}
