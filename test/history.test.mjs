// Page history, moving pages, trash, and the search space filter (0.11.0).
//
// No network: a stand-in client records every REST call the tools make and
// answers with canned bodies shaped like the AgentDocs API's.
import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerAllTools } from "../dist/lib.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const SPACE = "33333333-3333-4333-8333-333333333333";
const OTHER_SPACE = "44444444-4444-4444-8444-444444444444";
const WS = "55555555-5555-4555-8555-555555555555";

function makeCtx({ credential = { type: "account" }, respond = () => ({}) } = {}) {
  const calls = [];
  const ctx = {
    client: {
      baseUrl: "https://agentdocs.eu",
      async request(method, path, body, query) {
        calls.push({ method, path, body, query });
        return respond(method, path, body, query);
      },
    },
    resolver: {
      async workspaceId(ref) { return ref === "my-ws" ? WS : ref; },
      async spaceId(ref) {
        if (!ref) {
          if (credential.spaceId) return credential.spaceId;
          throw new Error('Missing "space"');
        }
        return ref === "my-ws/other" ? OTHER_SPACE : ref === "my-ws/docs" ? SPACE : ref;
      },
      async pageId(ref) { return ref === "my-ws/docs/parent" ? PARENT : ref === "my-ws/docs/page" ? PAGE : ref; },
    },
    credential,
    capabilities: { localFiles: false },
  };
  return { ctx, calls };
}

async function connect(ctx) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAllTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return client;
}

async function call(ctx, name, args) {
  const client = await connect(ctx);
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  return { result, text, json: result.isError ? null : JSON.parse(text) };
}

const NEW_TOOLS = [
  "list_page_versions",
  "get_page_version",
  "restore_page_version",
  "move_page",
  "list_trash",
  "restore_page",
];

test("the six new tools are registered for account and space credentials", async () => {
  for (const credential of [{ type: "account" }, { type: "space", spaceId: SPACE }]) {
    const { ctx } = makeCtx({ credential });
    const client = await connect(ctx);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const name of NEW_TOOLS) assert.ok(names.includes(name), `${name} missing for ${credential.type}`);
    // 19 base + 6 new; a space token loses the four workspace-level tools.
    assert.equal(names.length, credential.type === "space" ? 21 : 25);
  }
});

test("read tools are marked read-only and write tools are not", async () => {
  const { ctx } = makeCtx();
  const { tools } = await (await connect(ctx)).listTools();
  const hint = name => tools.find(t => t.name === name).annotations.readOnlyHint;
  for (const name of ["list_page_versions", "get_page_version", "list_trash"]) assert.equal(hint(name), true, name);
  for (const name of ["restore_page_version", "move_page", "restore_page"]) assert.equal(hint(name), false, name);
});

test("list_page_versions leaves out the text, newest first, and honours limit", async () => {
  const versions = [1, 3, 2, 7].map(v => ({
    id: `row-${v}`,
    page_id: PAGE,
    version: v,
    created_at: `2026-11-0${v}T00:00:00Z`,
    author_id: "author-uuid",
    author_name: "Jure",
    edited_via: v === 7 ? "oauth" : "web",
    token_name: v === 7 ? "ChatGPT" : null,
    content: "x".repeat(v * 10),
  }));
  const { ctx, calls } = makeCtx({ respond: () => ({ versions }) });
  const { json, text } = await call(ctx, "list_page_versions", { page: "my-ws/docs/page", limit: 2 });

  assert.deepEqual(calls[0], { method: "GET", path: `/api/pages/${PAGE}/versions`, body: undefined, query: undefined });
  assert.equal(json.page_id, PAGE);
  assert.equal(json.total, 4);
  assert.deepEqual(json.versions.map(v => v.version), [7, 3]);
  assert.deepEqual(json.versions[0], {
    version: 7,
    created_at: "2026-11-07T00:00:00Z",
    author_name: "Jure",
    edited_via: "oauth",
    token_name: "ChatGPT",
    content_length: 70,
  });
  assert.ok(!text.includes("xxxxxxxxxx"), "version text must not be returned");
});

test("list_page_versions copes with old rows that have no text or provenance", async () => {
  const { ctx } = makeCtx({ respond: () => ({ versions: [{ version: 1, created_at: "t", content: null }] }) });
  const { json } = await call(ctx, "list_page_versions", { page: PAGE });
  assert.deepEqual(json.versions[0], {
    version: 1, created_at: "t", author_name: null, edited_via: null, token_name: null, content_length: 0,
  });
});

test("get_page_version returns one version's text", async () => {
  const { ctx, calls } = makeCtx({
    respond: () => ({ version: { version: 4, created_at: "t", author_name: "A", edited_via: "api_token", token_name: null, content: "# Old" } }),
  });
  const { json } = await call(ctx, "get_page_version", { page: PAGE, version: 4 });
  assert.equal(calls[0].path, `/api/pages/${PAGE}/versions/4`);
  assert.equal(json.version.content, "# Old");
  assert.equal(json.version.edited_via, "api_token");
});

test("restore_page_version posts to the restore route and reports the new version", async () => {
  const { ctx, calls } = makeCtx({
    respond: () => ({ page: { id: PAGE, title: "T", slug: "t", version: 9, content: "long text" }, restored_from_version: 4 }),
  });
  const { json } = await call(ctx, "restore_page_version", { page: PAGE, version: 4 });
  assert.deepEqual(calls[0], { method: "POST", path: `/api/pages/${PAGE}/restore/4`, body: undefined, query: undefined });
  assert.deepEqual(json, { page: { id: PAGE, title: "T", slug: "t", version: 9 }, restored_from_version: 4 });
});

const moved = { page: { id: PAGE, title: "T", slug: "t", space_id: SPACE, parent_page_id: PARENT, content: "c" } };

test("move_page under a parent resolves the parent's path", async () => {
  const { ctx, calls } = makeCtx({ respond: () => moved });
  const { json } = await call(ctx, "move_page", { page: "my-ws/docs/page", parent_page: "my-ws/docs/parent" });
  assert.deepEqual(calls[0], { method: "PUT", path: `/api/pages/${PAGE}/move`, body: { parent_page_id: PARENT }, query: undefined });
  assert.deepEqual(json.page, { id: PAGE, title: "T", slug: "t", space_id: SPACE, parent_page_id: PARENT });
});

test("move_page top_level sends parent_page_id null, which the API reads as top level", async () => {
  const { ctx, calls } = makeCtx({ respond: () => moved });
  await call(ctx, "move_page", { page: PAGE, top_level: true });
  assert.deepEqual(calls[0].body, { parent_page_id: null });
});

test("move_page to another space sends space_id, and leaves the parent out when none is given", async () => {
  const { ctx, calls } = makeCtx({ respond: () => moved });
  await call(ctx, "move_page", { page: PAGE, space: "my-ws/other", top_level: true });
  assert.deepEqual(calls[0].body, { parent_page_id: null, space_id: OTHER_SPACE });

  const second = makeCtx({ respond: () => moved });
  await call(second.ctx, "move_page", { page: PAGE, space: OTHER_SPACE });
  assert.deepEqual(second.calls[0].body, { space_id: OTHER_SPACE });
  assert.ok(!("parent_page_id" in second.calls[0].body), "an omitted parent must stay omitted, not become null");
});

test("move_page refuses contradictory or empty requests before calling the API", async () => {
  const both = makeCtx();
  const r1 = await call(both.ctx, "move_page", { page: PAGE, parent_page: PARENT, top_level: true });
  assert.equal(r1.result.isError, true);
  assert.match(r1.text, /not both/);
  assert.equal(both.calls.length, 0);

  const none = makeCtx();
  const r2 = await call(none.ctx, "move_page", { page: PAGE });
  assert.equal(r2.result.isError, true);
  assert.match(r2.text, /Nothing to move to/);
  assert.equal(none.calls.length, 0);
});

test("list_trash uses a space token's own space and returns the restorable roots", async () => {
  const { ctx, calls } = makeCtx({
    credential: { type: "space", spaceId: SPACE },
    respond: () => ({
      retention_days: 30,
      pages: [{
        id: PAGE, title: "Gone", slug: "gone", parent_page_id: null, deleted_at: "t",
        deleted_by: "user-uuid", deleted_by_name: "Jure", last_edited_via: "web", descendant_count: 2,
      }],
    }),
  });
  const { json } = await call(ctx, "list_trash", {});
  assert.equal(calls[0].path, `/api/spaces/${SPACE}/trash`);
  assert.deepEqual(json, {
    retention_days: 30,
    pages: [{ id: PAGE, title: "Gone", slug: "gone", parent_page_id: null, deleted_at: "t", deleted_by_name: "Jure", descendant_count: 2 }],
  });
});

test("restore_page takes a UUID only, and posts to the page restore route", async () => {
  const bad = makeCtx();
  const r1 = await call(bad.ctx, "restore_page", { page_id: "my-ws/docs/page" });
  assert.equal(r1.result.isError, true);
  assert.match(r1.text, /UUID from list_trash/);
  assert.equal(bad.calls.length, 0);

  const { ctx, calls } = makeCtx({
    respond: () => ({
      message: "Page restored",
      restored: 3,
      page: { id: PAGE, title: "Gone", slug: "gone-2", space_id: SPACE, parent_page_id: null, content: "c" },
      slug_changed: true,
      reparented_to_root: true,
    }),
  });
  const { json } = await call(ctx, "restore_page", { page_id: PAGE });
  assert.deepEqual(calls[0], { method: "POST", path: `/api/pages/${PAGE}/restore`, body: undefined, query: undefined });
  assert.deepEqual(json, {
    restored: 3,
    page: { id: PAGE, title: "Gone", slug: "gone-2", space_id: SPACE, parent_page_id: null },
    slug_changed: true,
    reparented_to_root: true,
  });
});

test("search_docs and semantic_search pass spaceId only when a space is given", async () => {
  const respond = () => ({ results: [], mode: "fulltext" });

  const plain = makeCtx({ respond });
  await call(plain.ctx, "search_docs", { workspace: "my-ws", query: "billing" });
  assert.deepEqual(plain.calls[0], { method: "GET", path: `/api/workspaces/${WS}/search`, body: undefined, query: { q: "billing" } });

  const scoped = makeCtx({ respond });
  await call(scoped.ctx, "search_docs", { workspace: "my-ws", query: "billing", space: "my-ws/docs" });
  assert.deepEqual(scoped.calls[0].query, { q: "billing", spaceId: SPACE });

  const semantic = makeCtx({ respond });
  await call(semantic.ctx, "semantic_search", { workspace: WS, query: "how do retries work?", space: SPACE });
  assert.deepEqual(semantic.calls[0].query, { q: "how do retries work?", mode: "semantic", spaceId: SPACE });
});

test("delete_page no longer claims deletion is permanent", async () => {
  const { ctx } = makeCtx();
  const { tools } = await (await connect(ctx)).listTools();
  const description = tools.find(t => t.name === "delete_page").description;
  assert.doesNotMatch(description, /Permanently|no undo/i);
  assert.match(description, /trash/);
});
