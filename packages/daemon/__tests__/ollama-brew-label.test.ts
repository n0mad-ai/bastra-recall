/**
 * The re-probe after `brew services start` used to run even when brew was
 * never invoked, and labelled ANY server that answered on the port
 * "started via brew services". This file points the module at a local fake
 * server (BASTRA_OLLAMA_URL is read at import), so it runs in its own process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

test("with no brew, a server that comes up is not attributed to brew services", async (t) => {
  let calls = 0;
  // The first probe finds nothing; whatever answers afterwards was started by
  // someone else.
  const server = createServer((req, res) => {
    if (req.url === "/api/version" && calls++ === 0) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "0.0.0-test" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  process.env.BASTRA_OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { ensureServing } = await import("../src/cli/ollama.js");

  // autostart off: no brew, no systemd; the one-shot spawn is a no-op binary.
  const r = await ensureServing(false, null, "/usr/bin/true");
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.detail, /brew/, `no brew ran, yet: ${r.detail}`);
});
