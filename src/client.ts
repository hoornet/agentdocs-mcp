import type { Config } from "./config.js";

/**
 * Neon free tier suspends after ~5 min idle and takes 10-15s to wake; the
 * backend pool absorbs that with a 30s connection timeout. Mirror it here and
 * retry once so the first call after idle succeeds slowly instead of failing.
 */
const REQUEST_TIMEOUT_MS = 35_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function friendlyMessage(status: number, body: Record<string, unknown>, baseUrl: string): string {
  const serverMessage =
    typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";

  if (status === 401) {
    return (
      `Authentication failed (401)${serverMessage ? `: ${serverMessage}` : ""}. ` +
      `The configured token may have been revoked or rotated. ` +
      `Regenerate it at ${baseUrl} → Profile → Regenerate API Token and update AGENTDOCS_TOKEN.`
    );
  }

  // Tier-limit 403s carry a structured contract: { error, message, limit, current, tier, upgrade_url }
  if (status === 403 && typeof body.upgrade_url === "string") {
    const limit = body.limit !== undefined ? ` (${body.current}/${body.limit} on the ${body.tier} tier)` : "";
    const upgradeUrl = body.upgrade_url.startsWith("http") ? body.upgrade_url : `${baseUrl}${body.upgrade_url}`;
    return `${serverMessage || "Plan limit reached"}${limit}. Upgrade: ${upgradeUrl}`;
  }

  if (status === 403) {
    return (
      `Access denied (403)${serverMessage ? `: ${serverMessage}` : ""}. ` +
      `If you are using a space-scoped token, it only has access to its own space.`
    );
  }

  if (status === 429) {
    return `Rate limited (429). The API allows 300 requests per 15 minutes per credential — wait a bit and retry.`;
  }

  return `AgentDocs API error ${status}${serverMessage ? `: ${serverMessage}` : ""}`;
}

export class AgentDocsClient {
  constructor(private readonly config: Config) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    query?: Record<string, string>
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Token ${this.config.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchWithColdStartRetry(url, init);
    } catch (err) {
      throw new Error(
        `Could not reach ${this.config.baseUrl} (${err instanceof Error ? err.message : String(err)}). ` +
          `The server may be waking from idle (first request can take ~15s) — retry in a moment.`
      );
    }

    const text = await response.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON body (e.g. a platform error page during cold start)
        if (!response.ok) {
          throw new ApiError(response.status, {}, `AgentDocs API error ${response.status} (non-JSON response)`);
        }
      }
    }

    if (!response.ok) {
      throw new ApiError(response.status, json, friendlyMessage(response.status, json, this.config.baseUrl));
    }

    return json as T;
  }

  private async fetchWithColdStartRetry(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // One retry on timeout / transient network failure (Neon cold start, flaky DNS).
      const retriable =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || err.name === "TypeError");
      if (!retriable) throw err;
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
  }
}
