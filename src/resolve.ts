import type { AgentDocsClient } from "./client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const SLASH = 47; // "/"

/**
 * Upper bound on a slug reference. The longest legitimate form is
 * "workspaceSlug/spaceSlug/pageSlug", so this is generous by a wide margin;
 * it exists to reject junk early rather than to constrain real callers.
 */
const MAX_REF_LENGTH = 1024;

/**
 * Strips leading and trailing "/" in linear time.
 *
 * Do NOT "simplify" this back to `ref.replace(/^\/+|\/+$/g, "")`. That regex is
 * polynomial (CodeQL js/polynomial-redos, alerts 1–3): the unanchored `\/+$`
 * branch retries at every start offset, so a slash run that does not reach the
 * end of the string — "a" + "/".repeat(n) + "b" — costs O(n²). Measured on
 * Node 20: 20k slashes 255ms, 80k 4.0s, 320k 65s. That input is reachable from
 * an authenticated tool call: these refs are bare `z.string()` and the hosted
 * `/mcp` endpoint runs this code in the same single process that serves the
 * site, so one 1 MB request could stall it for minutes.
 */
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === SLASH) start++;
  while (end > start && value.charCodeAt(end - 1) === SLASH) end--;
  return value.slice(start, end);
}

function normalizeRef(ref: string, kind: "workspace" | "space" | "page"): string {
  if (ref.length > MAX_REF_LENGTH) {
    throw new Error(
      `Invalid ${kind} reference — references are limited to ${MAX_REF_LENGTH} characters (got ${ref.length}).`
    );
  }
  return trimSlashes(ref);
}

interface ResolveResponse {
  workspace?: { id: string };
  space?: { id: string };
  page?: { id: string };
}

/**
 * Resolves human-friendly slug paths ("workspace/space/page") to entity UUIDs
 * via GET /api/resolve/..., with a small per-process cache.
 *
 * Space-scoped tokens cannot call /api/resolve (it is workspace-scoped), so
 * when the credential is a space token we only accept UUIDs and fall back to
 * the token's own space as the default.
 */
export class Resolver {
  private cache = new Map<string, string>();

  constructor(
    private readonly client: AgentDocsClient,
    private readonly slugResolutionAllowed: boolean,
    private readonly defaultSpaceId?: string
  ) {}

  async workspaceId(ref: string): Promise<string> {
    if (isUuid(ref)) return ref;
    const slug = normalizeRef(ref, "workspace");
    if (slug.includes("/")) {
      throw new Error(`Invalid workspace reference "${ref}" — expected a workspace UUID or a single workspace slug.`);
    }
    return this.resolve(slug, "workspace");
  }

  async spaceId(ref?: string): Promise<string> {
    if (!ref) {
      if (this.defaultSpaceId) return this.defaultSpaceId;
      throw new Error(
        'Missing "space" — pass a space UUID or a "workspaceSlug/spaceSlug" path. (Only space-scoped tokens have an implicit default space.)'
      );
    }
    if (isUuid(ref)) return ref;
    const path = normalizeRef(ref, "space");
    if (path.split("/").length !== 2) {
      throw new Error(`Invalid space reference "${ref}" — expected a space UUID or "workspaceSlug/spaceSlug".`);
    }
    return this.resolve(path, "space");
  }

  async pageId(ref: string): Promise<string> {
    if (isUuid(ref)) return ref;
    const path = normalizeRef(ref, "page");
    if (path.split("/").length !== 3) {
      throw new Error(`Invalid page reference "${ref}" — expected a page UUID or "workspaceSlug/spaceSlug/pageSlug".`);
    }
    return this.resolve(path, "page");
  }

  private async resolve(path: string, kind: "workspace" | "space" | "page"): Promise<string> {
    const cacheKey = `${kind}:${path}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!this.slugResolutionAllowed) {
      throw new Error(
        `Slug resolution ("${path}") is not available with a space-scoped token — use UUIDs, or omit "space" to target the token's own space.`
      );
    }

    const encoded = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const result = await this.client.request<ResolveResponse>("GET", `/api/resolve/${encoded}`);
    const id = result[kind]?.id;
    if (!id) {
      throw new Error(`Could not resolve ${kind} from "${path}".`);
    }
    this.cache.set(cacheKey, id);
    return id;
  }
}
