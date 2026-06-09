// End-to-end smoke test: drives the built server over stdio against a real
// AgentDocs instance. Requires an account token (env AGENTDOCS_TOKEN or
// ~/.config/agentdocs/token) and two env vars pointing at YOUR data:
//
//   SMOKE_TESTBED_SPACE  "workspaceSlug/spaceSlug" of a scratch space —
//                        the test creates and deletes pages in it
//   SMOKE_KNOWN_PAGE     "workspaceSlug/spaceSlug/pageSlug" of any existing
//                        page (read-only checks)
//
// Run: SMOKE_TESTBED_SPACE=... SMOKE_KNOWN_PAGE=... node test/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TESTBED_SPACE = process.env.SMOKE_TESTBED_SPACE;
const KNOWN_PAGE = process.env.SMOKE_KNOWN_PAGE;
if (!TESTBED_SPACE || !KNOWN_PAGE) {
  console.error("Set SMOKE_TESTBED_SPACE and SMOKE_KNOWN_PAGE (see header of this file).");
  process.exit(1);
}
const TESTBED_WORKSPACE_SLUG = TESTBED_SPACE.split("/")[0];
const TESTBED_SPACE_SLUG = TESTBED_SPACE.split("/")[1];

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);

const text = (result) => result.content?.[0]?.text ?? "";
const json = (result) => JSON.parse(text(result));
const call = (name, args = {}) => client.callTool({ name, arguments: args });

// 1. Tool listing
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  "append_to_page", "bulk_create_pages", "create_page", "delete_page", "get_page",
  "list_pages", "list_spaces", "list_workspaces", "search_docs", "share_page",
  "update_page", "whoami",
].sort();
check("tools/list exposes all 12 tools", JSON.stringify(names) === JSON.stringify(expected), names.join(","));

// 2. whoami
const me = json(await call("whoami"));
check("whoami returns account credential", me.credential?.type === "account");

// 3. list_workspaces / list_spaces (slug input)
const workspaces = json(await call("list_workspaces"));
check("list_workspaces", Array.isArray(workspaces.workspaces) && workspaces.workspaces.length >= 1);
const spaces = json(await call("list_spaces", { workspace: TESTBED_WORKSPACE_SLUG }));
check("list_spaces via workspace slug", spaces.spaces?.some((s) => s.slug === TESTBED_SPACE_SLUG));

// 4. get_page via slug path
const known = json(await call("get_page", { page: KNOWN_PAGE }));
check("get_page via slug path", typeof known.page?.content === "string" && known.page.version >= 1, `v${known.page?.version}`);

// 5. search_docs — search the known page's title, expect its slug among results
const knownWorkspaceSlug = KNOWN_PAGE.split("/")[0];
const knownPageSlug = KNOWN_PAGE.split("/")[2];
const search = json(await call("search_docs", { workspace: knownWorkspaceSlug, query: known.page.title }));
check("search_docs finds the known page", search.results?.some((r) => r.slug === knownPageSlug));

// 6. create_page in testbed
const created = json(await call("create_page", {
  space: TESTBED_SPACE,
  title: "MCP smoke test (safe to delete)",
  content: "# MCP smoke test\n\nCreated by test/smoke.mjs.",
}));
const pageId = created.page?.id;
check("create_page", Boolean(pageId), pageId);

// 7. append_to_page
const appended = json(await call("append_to_page", { page: pageId, content: "Appended line." }));
check("append_to_page bumps version", appended.page?.version === 2, `v${appended.page?.version}`);

// 8. update_page with stale expected_version → must error
const conflict = await call("update_page", { page: pageId, content: "overwrite", expected_version: 1 });
check("update_page stale version is rejected", conflict.isError === true && text(conflict).includes("Version conflict"));

// 9. update_page with correct expected_version
const updated = json(await call("update_page", { page: pageId, title: "MCP smoke test (updated)", expected_version: 2 }));
check("update_page with correct version", updated.page?.version === 3 && updated.page?.title?.includes("updated"));

// 10. share_page → absolute raw URL fetchable without auth
const share = json(await call("share_page", { page: pageId, expires_in_days: 1 }));
const rawUrl = share.share_link?.raw_markdown_url;
check("share_page returns absolute URLs", /^https?:\/\/.+\/api\/shared\/.+\/raw$/.test(rawUrl ?? ""));
const rawResp = await fetch(rawUrl);
const rawBody = await rawResp.text();
check("shared raw markdown is publicly readable", rawResp.ok && rawBody.includes("MCP smoke test"));

// 11. bulk_create_pages
const bulk = json(await call("bulk_create_pages", {
  space: TESTBED_SPACE,
  pages: [
    { title: "MCP bulk smoke 1", content: "one" },
    { title: "MCP bulk smoke 2", content: "two" },
  ],
}));
check("bulk_create_pages", bulk.created === 2);

// 12. delete_page (cleanup: smoke page + bulk pages)
for (const id of [pageId, ...bulk.pages.map((p) => p.id)]) {
  await call("delete_page", { page: id });
}
const afterDelete = await call("get_page", { page: pageId });
check("delete_page removes the page", afterDelete.isError === true);

// 13. Error shape: nonexistent slug path
const missing = await call("get_page", { page: `${TESTBED_SPACE}/does-not-exist-xyz` });
check("missing page surfaces a clean error", missing.isError === true);

await client.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
