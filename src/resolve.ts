import type { AgentDocsClient } from "./client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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
    const slug = ref.replace(/^\/+|\/+$/g, "");
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
    const path = ref.replace(/^\/+|\/+$/g, "");
    if (path.split("/").length !== 2) {
      throw new Error(`Invalid space reference "${ref}" — expected a space UUID or "workspaceSlug/spaceSlug".`);
    }
    return this.resolve(path, "space");
  }

  async pageId(ref: string): Promise<string> {
    if (isUuid(ref)) return ref;
    const path = ref.replace(/^\/+|\/+$/g, "");
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
