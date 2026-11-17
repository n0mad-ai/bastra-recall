/**
 * Invariant: the daemon's network surface is loopback-only (docs/invariants.md, #1570).
 *
 * The vault is reachable without a token from a direct local caller (#526), so a
 * listener on 0.0.0.0 or :: would hand it to the whole network. Every TCP listener
 * the daemon opens therefore names 127.0.0.1; a Unix socket or an inherited file
 * descriptor has no network address and is fine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listenHttp } from "../src/http-listen.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("INV-HTTP-01: the HTTP server listens on 127.0.0.1 only", async (t) => {
  const server = createServer();
  const handle = await listenHttp(server, 0);
  t.after(() => handle.close());
  assert.ok(handle.port, "the server is listening");
  assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
});

test("INV-HTTP-01: every TCP listener in the daemon sources names 127.0.0.1", () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(join(srcDir, entry), "utf8");
    for (const m of text.matchAll(/\.listen\(([^)]*)\)?/g)) {
      seen++;
      const args = m[1]!.trim();
      const loopback = args.includes('"127.0.0.1"');
      const inheritedFd = /^\{\s*fd\s*:/.test(args);
      const unixSocket = /^[A-Za-z_$][\w$.]*(socket|path)[\w$]*\s*,/i.test(args);
      if (!loopback && !inheritedFd && !unixSocket) offenders.push(`${entry}: .listen(${args})`);
    }
  }
  assert.ok(seen >= 3, `found only ${seen} listen calls, the source scan is broken`);
  assert.deepEqual(offenders, [], "a listener without an explicit 127.0.0.1 host");
});
