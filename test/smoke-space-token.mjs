// Space-token mode smoke test: workspace tools hidden, implicit default space.
// Run: AGENTDOCS_TOKEN=<space-token> node test/smoke-space-token.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "smoke-space", version: "0.0.0" });
await client.connect(transport);

const text = (result) => result.content?.[0]?.text ?? "";
const json = (result) => JSON.parse(text(result));
const call = (name, args = {}) => client.callTool({ name, arguments: args });

// 1. Workspace-scoped tools are hidden
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check("9 tools exposed (workspace tools hidden)", names.length === 9, names.sort().join(","));
check(
  "list_workspaces/list_spaces/search_docs absent",
  !names.includes("list_workspaces") && !names.includes("list_spaces") && !names.includes("search_docs")
);

// 2. whoami reports space credential
const me = json(await call("whoami"));
check("whoami reports space credential", me.credential?.type === "space", me.credential?.space_slug);

// 3. list_pages with no space arg → token's own space
const pages = json(await call("list_pages"));
check("list_pages defaults to token's space", Array.isArray(pages.pages));

// 4. create + delete without specifying space
const created = json(await call("create_page", {
  title: "MCP space-token smoke (safe to delete)",
  content: "created via space token",
}));
check("create_page defaults to token's space", Boolean(created.page?.id));
const del = await call("delete_page", { page: created.page.id });
check("delete_page works in-scope", !del.isError);

// 5. slug paths rejected with a clear message
const slugAttempt = await call("get_page", { page: "some-workspace/some-space/some-page" });
check(
  "slug resolution rejected with clear error",
  slugAttempt.isError === true && text(slugAttempt).includes("space-scoped token"),
  text(slugAttempt).slice(0, 80)
);

await client.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
