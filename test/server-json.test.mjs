// server.json is what the official MCP registry publishes, and it is validated
// server-side at publish time — a violation is a 422 in the maintainer's face,
// after they have already logged in and pushed a release. Both failure modes
// below have actually happened, so they are pinned here instead:
//
//   * 0.10.0 and 0.10.1 shipped to npm while server.json still said 0.9.3, so
//     the listing sat two releases behind.
//   * A description rewrite ran to 159 characters against a 100-char cap and
//     the publish was rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Limits from https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
const LIMITS = { description: 100, title: 100, name: 200, version: 255 };

test("server.json respects the registry's field length limits", () => {
  for (const [field, max] of Object.entries(LIMITS)) {
    const value = server[field];
    if (value === undefined) continue;
    assert.ok(
      value.length <= max,
      `server.json ${field} is ${value.length} chars, limit is ${max}: ${JSON.stringify(value)}`
    );
  }
});

test("server.json version matches the npm package version", () => {
  assert.equal(server.version, pkg.version, "server.json version has drifted from package.json");
  assert.equal(
    server.packages[0].version,
    pkg.version,
    "server.json packages[0].version has drifted from package.json"
  );
});

test("package.json carries mcpName for the registry's ownership check", () => {
  assert.equal(pkg.mcpName, server.name);
});
