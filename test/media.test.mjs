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


// --- source_url transport: bounded read + connect-time address check -------
//
// Found by an external static scan of the AgentDocs backend (2026-10-08), where
// this code runs in-process on POST /mcp: the old fetchImage buffered the whole
// response with arrayBuffer() BEFORE comparing it to the 5 MB cap, and checked
// DNS once, then let global fetch resolve the hostname again on its own.
import { createServer } from "node:http";
import { createServer as createRawServer } from "node:net";
import { fetchImage, isPrivateAddress, makeGuardedLookup } from "../dist/tools/media.js";

// net.connect skips `lookup` for IP literals, so the local receiver is addressed
// by NAME and this injected lookup answers for it — standing in for "the DNS
// check was satisfied". Production never passes a lookup.
const passthrough = (hostname, options, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  if (options && options.all) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
  cb(null, "127.0.0.1", 4);
};

async function withServer(handler, fn) {
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); handler(req, res); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await fn(`http://receiver.test:${port}`, hits, port);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
}

test("isPrivateAddress covers the ranges the old prefix checks missed", () => {
  for (const ip of ["::ffff:127.0.0.1", "::ffff:10.0.0.1", "100.64.0.1", "0.0.0.1", "224.0.0.1", "192.0.0.1", "255.255.255.255", "::", "fd00::1", "fe80::1",
                    "198.18.0.1", "fec0::1", "100::1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b:1::7f00:1", "2002:7f00:1::", "2001::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "2001:db8::1", "2a00:1450:4001::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  assert.equal(isPrivateAddress("not-an-ip"), false);
});

test("the guarded lookup refuses a private answer, even one among public ones", async () => {
  const lookup = makeGuardedLookup((h, o, cb) =>
    cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.9.9.9", family: 4 }]));
  await assert.rejects(
    new Promise((res, rej) => lookup("x.test", { all: true }, (e, a) => (e ? rej(e) : res(a)))),
    /private or loopback/
  );
  const ok = makeGuardedLookup((h, o, cb) => cb(null, "93.184.216.34", 4));
  const got = await new Promise((res, rej) => ok("x.test", {}, (e, a, f) => (e ? rej(e) : res([a, f]))));
  assert.deepEqual(got, ["93.184.216.34", 4]);
});

test("fetchImage returns the bytes of a small image", async () => {
  await withServer((req, res) => { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); },
    async base => {
      const bytes = await fetchImage(`${base}/shot.png`, { lookup: passthrough });
      assert.equal(Buffer.compare(bytes, PNG), 0);
    });
});

test("a declared Content-Length over the cap is refused before any body is read", async () => {
  await withServer((req, res) => {
    // Headers only, never a body: if the client waited for the body it would
    // hit the (short) timeout instead of the size error.
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": 6 * 1024 * 1024 });
    res.flushHeaders();
  }, async base => {
    await assert.rejects(fetchImage(`${base}/big.png`, { lookup: passthrough, timeoutMs: 2000 }), /6\.0 MB; the limit is 5 MB/);
  });
});

test("an undeclared (chunked) body is stopped at the cap, not buffered", async () => {
  let written = 0;
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" }); // no Content-Length → chunked
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    const pump = () => {
      if (res.destroyed || res.writableEnded) return;
      written += chunk.length;
      if (res.write(chunk)) setImmediate(pump); else res.once("drain", pump);
    };
    pump();
  }, async base => {
    const cap = 256 * 1024;
    await assert.rejects(
      fetchImage(`${base}/stream.png`, { lookup: passthrough, maxBytes: cap, timeoutMs: 5000 }),
      /larger than 0\.3 MB \(download stopped at the limit\)/
    );
    // The receiver was cut off, not drained: after the rejection the server
    // must stop making progress (a mutant that keeps reading past the cap
    // rejects at the same moment but lets `written` keep climbing).
    const atRejection = written;
    await new Promise(r => setTimeout(r, 200));
    assert.equal(written, atRejection, "server kept writing after the client rejected");
    assert.ok(written < 4 * 1024 * 1024, `server wrote ${written} bytes`);
  });
});

test("the deadline keeps running after headers — a stalled body times out", async () => {
  let stalled;
  await withServer((req, res) => { res.writeHead(200); res.write("partial"); stalled = res; },
    async base => {
      await assert.rejects(fetchImage(`${base}/slow.png`, { lookup: passthrough, timeoutMs: 300 }), /timed out/);
      stalled?.destroy();
    });
});

test("redirects are not followed", async () => {
  await withServer((req, res) => {
    if (req.url === "/start.png") { res.writeHead(302, { Location: "/followed.png" }); return res.end(); }
    res.writeHead(200); res.end(PNG);
  }, async (base, hits) => {
    await assert.rejects(fetchImage(`${base}/start.png`, { lookup: passthrough }), /redirects are not followed/);
    assert.deepEqual(hits, ["/start.png"]);
  });
});

test("non-2xx is an error", async () => {
  await withServer((req, res) => { res.writeHead(404); res.end("nope"); },
    async base => {
      await assert.rejects(fetchImage(`${base}/missing.png`, { lookup: passthrough }), /HTTP 404/);
    });
});

test("a 5 MB body sent as one-byte HTTP chunks is refused, not held as five million Buffers", async () => {
  // Byte-counting alone accepts this (the total never exceeds the cap), but
  // one Buffer object per chunk was measured at ~1 GB of heap. Bytes are
  // copied into one buffer and a pathologically fragmented response is cut.
  let chunksSent = 0;
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    const pump = () => {
      if (res.destroyed || res.writableEnded) return;
      let ok = true;
      for (let i = 0; i < 2048 && ok; i++) { ok = res.write("x"); chunksSent++; }
      if (ok) setImmediate(pump); else res.once("drain", pump);
    };
    pump();
  }, async base => {
    const before = process.memoryUsage().heapUsed;
    await assert.rejects(fetchImage(`${base}/frag.png`, { lookup: passthrough, timeoutMs: 10_000 }), /fragmented into too many pieces/);
    const grown = process.memoryUsage().heapUsed - before;
    assert.ok(grown < 64 * 1024 * 1024, `heap grew by ${(grown / 1024 / 1024).toFixed(0)} MB`);
    assert.ok(chunksSent < 2_000_000, `server sent ${chunksSent} chunks before being cut off`);
  });
});

test("a 101 Switching Protocols reply does not hang — the deadline still settles", async () => {
  // Node answers a 101 with no 'upgrade' listener by destroying the socket
  // and emitting only 'close' — no 'response', no 'error'. A timer that only
  // calls req.destroy() then does nothing, because the request is already
  // destroyed, and the promise stays pending forever.
  const server = createRawServer(sock => {
    sock.once("data", () => sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n"));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const started = Date.now();
    await assert.rejects(
      fetchImage(`http://receiver.test:${server.address().port}/x.png`, { lookup: passthrough, timeoutMs: 500 }),
      /connection closed before a complete response|timed out/
    );
    assert.ok(Date.now() - started < 3000, "took too long to settle");
  } finally {
    server.close();
  }
});

test("the connect-time check is the ONLY resolution — one lookup, refused, nothing connects", async () => {
  // The old design resolved for the check and then let fetch resolve again;
  // a TTL-0 record could differ between the two. Now the single lookup the
  // socket uses is the one that is checked.
  let calls = 0;
  const countingBase = (h, o, cb) => { calls++; cb(null, o && o.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4); };
  await withServer((req, res) => { res.writeHead(200); res.end(PNG); }, async (base, hits) => {
    await assert.rejects(fetchImage(`${base}/x.png`, { lookup: makeGuardedLookup(countingBase) }), /private or loopback/);
    assert.equal(calls, 1);
    assert.equal(hits.length, 0);
  });
});

test("refuses non-HTTP ports and credentials in the URL", async () => {
  await assert.rejects(fetchImage("http://example.com:25/x.png"), /port 25 is not an HTTP port/);
  await assert.rejects(fetchImage("http://example.com:6667/x.png"), /port 6667/);
  await assert.rejects(fetchImage("http://user:pw@example.com/x.png"), /must not contain credentials/);
});

test("with the REAL guard a loopback hostname is refused before any bytes move", async () => {
  await withServer((req, res) => { res.writeHead(200); res.end(PNG); },
    async (base, hits, port) => {
      await assert.rejects(fetchImage(`http://localhost:${port}/shot.png`, { timeoutMs: 2000 }), /private or loopback/);
      assert.equal(hits.length, 0);
    });
});

test("blocked IP literals are refused without a lookup, in every spelling", async () => {
  let lookups = 0;
  const spy = (h, o, cb) => { lookups++; cb(new Error("lookup must not be called for a literal")); };
  for (const host of ["127.0.0.1", "[::1]", "169.254.169.254", "[::ffff:127.0.0.1]", "2130706433", "0x7f000001", "[64:ff9b::7f00:1]", "[::7f00:1]", "100.64.0.1"]) {
    await assert.rejects(fetchImage(`http://${host}/x.png`, { lookup: spy, timeoutMs: 2000 }), /private or loopback/, host);
  }
  assert.equal(lookups, 0);
});
