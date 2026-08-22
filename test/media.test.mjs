// upload_image — the transport gate above all.
//
// registerAllTools is shared by this stdio package and by AgentDocs' backend,
// which registers the same tools per request on POST /mcp. The `path` argument
// reads a file from the machine the server runs on: correct for stdio, and
// arbitrary file read on the production host if it were ever honoured remotely.
// These tests pin that boundary in both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerMediaTools } from "../dist/tools/media.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

/** Minimal stand-ins: no network, just a record of what the tool tried to send. */
function makeCtx({ localFiles }) {
  const uploads = [];
  return {
    uploads,
    ctx: {
      client: {
        baseUrl: "https://agentdocs.eu",
        async uploadFile(path, file) {
          uploads.push({ path, file });
          return { url: "/api/uploads/abc.png", id: "up-1", filename: "abc.png", size_bytes: file.bytes.length };
        },
      },
      resolver: { async spaceId() { return "space-uuid"; } },
      credential: { type: "account" },
      capabilities: { localFiles },
    },
  };
}

async function connect(ctx) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerMediaTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return { client, server };
}

function textOf(result) {
  return result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

test("stdio surface (localFiles: true) uploads a file from a path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdocs-media-"));
  const file = join(dir, "shot.png");
  writeFileSync(file, PNG);

  const { ctx, uploads } = makeCtx({ localFiles: true });
  const { client } = await connect(ctx);

  const result = await client.callTool({ name: "upload_image", arguments: { path: file, space: "ws/sp" } });

  assert.ok(!result.isError, textOf(result));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, "/api/spaces/space-uuid/uploads");
  assert.equal(uploads[0].file.mimeType, "image/png");
  assert.equal(Buffer.compare(uploads[0].file.bytes, PNG), 0);
  assert.match(textOf(result), /!\[/); // returns embeddable markdown
});

test("remote surface (localFiles: false) REFUSES a path and uploads nothing", async () => {
  const { ctx, uploads } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({ name: "upload_image", arguments: { path: "/etc/passwd" } });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /cannot read files from your machine/);
  assert.equal(uploads.length, 0, "a refused path must not reach the API");
});

test("a context with no capabilities defaults to refusing paths", async () => {
  const { ctx, uploads } = makeCtx({ localFiles: true });
  delete ctx.capabilities; // simulate an older/forgetful caller
  const { client } = await connect(ctx);

  const result = await client.callTool({ name: "upload_image", arguments: { path: "/etc/passwd" } });

  assert.equal(result.isError, true);
  assert.equal(uploads.length, 0);
});

test("base64 data works on the remote surface", async () => {
  const { ctx, uploads } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: "upload_image",
    arguments: { data: PNG.toString("base64"), space: "ws/sp" },
  });

  assert.ok(!result.isError, textOf(result));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].file.mimeType, "image/png");
});

test("rejects a non-image by magic bytes, not by filename", async () => {
  const { ctx, uploads } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: "upload_image",
    arguments: { data: Buffer.from("#!/bin/sh\nrm -rf /").toString("base64"), filename: "innocent.png" },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unsupported image format/);
  assert.equal(uploads.length, 0);
});

test("SVG is rejected — it is a script-injection vector server-side", async () => {
  const { ctx } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: "upload_image",
    arguments: { data: Buffer.from('<svg onload="alert(1)"></svg>').toString("base64") },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unsupported image format/);
});

test("source_url refuses a private address (SSRF guard)", async () => {
  const { ctx, uploads } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: "upload_image",
    arguments: { source_url: "http://127.0.0.1:8001/internal.png" },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /private or loopback/);
  assert.equal(uploads.length, 0);
});

test("source_url refuses the cloud metadata address", async () => {
  const { ctx } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: "upload_image",
    arguments: { source_url: "http://169.254.169.254/latest/meta-data/" },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /private or loopback/);
});

test("requires exactly one source", async () => {
  const { ctx } = makeCtx({ localFiles: true });
  const { client } = await connect(ctx);

  const none = await client.callTool({ name: "upload_image", arguments: {} });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /No image source given/);

  const both = await client.callTool({
    name: "upload_image",
    arguments: { path: "/tmp/a.png", data: PNG.toString("base64") },
  });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /only one of/);
});

test("accepts a data: URI wrapper, not just bare base64", async () => {
  // Agents reach for "data:image/png;base64,..." naturally. Before this was
  // stripped, the whole string decoded to garbage and failed the format sniff
  // with a misleading "unsupported format" error.
  const { ctx, uploads } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: "upload_image",
    arguments: { data: `data:image/png;base64,${PNG.toString("base64")}`, space: "ws/sp" },
  });

  assert.ok(!result.isError, textOf(result));
  assert.equal(uploads.length, 1);
  assert.equal(Buffer.compare(uploads[0].file.bytes, PNG), 0);
});

test("does not return a misleading absolute_url", async () => {
  // On the remote surface client.baseUrl is a synthetic self-base nothing
  // dials, so an absolute URL rendered from it points at 127.0.0.1 and an
  // agent following it fails.
  const { ctx } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: "upload_image",
    arguments: { data: PNG.toString("base64"), space: "ws/sp" },
  });

  const payload = JSON.parse(textOf(result));
  assert.equal(payload.absolute_url, undefined);
  assert.equal(payload.url, "/api/uploads/abc.png");
  assert.match(payload.markdown, /^!\[.*\]\(\/api\/uploads\/abc\.png\)$/);
});

test("tool description tells an agent how to supply bytes it can only see", async () => {
  const { ctx } = makeCtx({ localFiles: false });
  const { client } = await connect(ctx);
  const { tools } = await client.listTools();
  const t = tools.find(x => x.name === "upload_image");

  assert.match(t.description, /PNG, JPEG, GIF, WebP/);
  assert.match(t.description, /5 MB/);
  assert.match(t.description, /only SEE an image/);
  // The remote surface must not advertise `path` as usable.
  assert.match(t.inputSchema.properties.path.description, /NOT SUPPORTED/);
});

