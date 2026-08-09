// Unit tests for src/resolve.ts — no credentials, no network.
//
//   npm run test:unit        (builds first, then runs this)
//   node --test test/resolve.test.mjs
//
// Unlike test/smoke*.mjs these run anywhere, so they are the regression guard
// for the ReDoS fix (CodeQL js/polynomial-redos, alerts 1-3).
import test from "node:test";
import assert from "node:assert/strict";
import { Resolver, isUuid } from "../dist/resolve.js";

const UUID = "3f8a1c2e-4b5d-6a7f-8901-2c3d4e5f6a7b";

/** Stub client: records the paths requested and replays canned responses. */
function stubClient(response = {}) {
  const calls = [];
  return {
    calls,
    request(method, path) {
      calls.push({ method, path });
      return Promise.resolve(response);
    },
  };
}

test("isUuid accepts a UUID and rejects a slug", () => {
  assert.equal(isUuid(UUID), true);
  assert.equal(isUuid("my-team-docs"), false);
});

test("UUIDs pass through without a resolve call", async () => {
  const client = stubClient();
  const resolver = new Resolver(client, true);
  assert.equal(await resolver.pageId(UUID), UUID);
  assert.equal(client.calls.length, 0);
});

test("surrounding slashes are trimmed before resolving", async () => {
  const client = stubClient({ page: { id: UUID } });
  const resolver = new Resolver(client, true);
  assert.equal(await resolver.pageId("//ws/space/page//"), UUID);
  assert.equal(client.calls[0].path, "/api/resolve/ws/space/page");
});

test("segment counts are enforced per kind", async () => {
  const resolver = new Resolver(stubClient(), true);
  await assert.rejects(() => resolver.workspaceId("ws/space"), /Invalid workspace reference/);
  await assert.rejects(() => resolver.spaceId("ws"), /Invalid space reference/);
  await assert.rejects(() => resolver.pageId("ws/space"), /Invalid page reference/);
});

test("over-long references are rejected", async () => {
  const resolver = new Resolver(stubClient(), true);
  const huge = "a".repeat(1025);
  await assert.rejects(() => resolver.pageId(huge), /limited to 1024 characters/);
});

// The regression guard. With the old `ref.replace(/^\/+|\/+$/g, "")` this input
// is quadratic: a slash run that never reaches end-of-string makes the
// unanchored `\/+$` branch retry at every offset. Measured on Node 20, 320k
// slashes took 65s and 1M would take minutes. Linear trimming is sub-millisecond,
// so the 2s budget is ~1000x headroom and cannot flake on a slow runner.
test("a large slash run does not blow up (ReDoS regression)", async () => {
  const resolver = new Resolver(stubClient(), true);
  const pathological = "a" + "/".repeat(1_000_000) + "b";
  const started = process.hrtime.bigint();
  await assert.rejects(() => resolver.pageId(pathological));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `took ${elapsedMs.toFixed(0)}ms — trimming is not linear`);
});
