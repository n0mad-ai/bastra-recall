/**
 * #1472 — doctor reports per client whether the daemon hands over the MCP tool
 * list for that client's surface, and what it costs at session start: names
 * plus server instructions for a client that loads descriptions on demand,
 * the full list as the addition for one that loads everything at once.
 *
 * The daemon is a local stand-in on an ephemeral port: the probe makes exactly
 * the read-only GET the forwarder makes, and nothing else.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/doctor-delivery.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  clientMcpSurface,
  deliveryLines,
  fetchToolsFromDaemon,
  printDeliveryNote,
  serverInstructionChars,
} from "../src/cli/doctor-delivery.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp-instructions.js";

test("#1472: the probe asks /tools for the client's surface and measures the list", async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tools: [{ name: "recall", description: "x".repeat(396) }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;

  const probe = await fetchToolsFromDaemon(`http://127.0.0.1:${port}`)("write");
  assert.deepEqual(seen, ["GET /tools?surface=write"]);
  assert.ok(probe.ok);
  assert.equal(probe.tools, 1);
  assert.equal(probe.bytes, JSON.stringify([{ name: "recall", description: "x".repeat(396) }]).length);
  // A deferring client lists the name only, prefixed with the server key.
  assert.equal(probe.names, "mcp__bastra-recall__recall".length);
});

test("#1472: an unreachable daemon or a broken answer is named, not thrown", async (t) => {
  const down = await fetchToolsFromDaemon("http://127.0.0.1:1")("full");
  assert.equal(down.ok, false);
  assert.match(!down.ok ? down.detail : "", /not reachable/);

  const server = createServer((_req, res) => {
    res.statusCode = 503;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const failing = await fetchToolsFromDaemon(`http://127.0.0.1:${port}`)("full");
  assert.deepEqual(failing, { ok: false, detail: "daemon answered HTTP 503" });
});

test("#1472: one line per client, with the start value, the full value, or the reason it did not arrive", () => {
  const lines = deliveryLines(
    [
      { surface: "claude-code", mcpSurface: "write", probe: { ok: true, tools: 57, bytes: 102_000, names: 2_000 } },
      { surface: "codex", mcpSurface: "full", probe: { ok: false, detail: "daemon not reachable (fetch failed)" } },
    ],
    "en",
    2_200
  );
  assert.equal(lines.length, 3);
  // Start: (names 2000 + instructions 2200) / 4; full: (102000 + 2200) / 4.
  assert.match(
    lines[1],
    /✓ claude-code: MCP lists 57 tools \(surface write\), ~1050 tokens at session start \(tool names \+ server instructions; descriptions load when needed\) — ~26050 tokens for a client that loads every description at start/
  );
  assert.match(lines[2], /⚠ codex: MCP tool list not delivered.*daemon not reachable.*falls back to the bundled list/);
  assert.deepEqual(deliveryLines([]), [], "no client, no block");
  assert.match(
    deliveryLines(
      [{ surface: "codex", mcpSurface: "full", probe: { ok: true, tools: 1, bytes: 400, names: 40 } }],
      "de",
      0
    )[1],
    /~10 Tokens beim Sitzungsstart \(Werkzeugnamen \+ Server-Anleitung; .*\) — ~100 Tokens bei einem Client, der alle Beschreibungen sofort lädt/
  );
});

test("#1472: the start value counts the server instructions the forwarder sends", async () => {
  const chars = await serverInstructionChars();
  assert.ok(chars >= SERVER_INSTRUCTIONS.length, "at least the base instructions");
});

test("#1472: the client's surface comes from its MCP entry, default full", () => {
  assert.equal(clientMcpSurface({ env: { BASTRA_TOOL_SURFACE: "write" } }), "write");
  assert.equal(clientMcpSurface({ env: {} }), "full");
  assert.equal(clientMcpSurface(undefined), "full");
});

test("#1472: the printer skips clients without a registered MCP entry and never throws", async (t) => {
  const asked: string[] = [];
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = write;
  });
  await printDeliveryNote(
    [{ surface: "claude-code", mcpSurface: "search" }, { surface: "cursor" }],
    async (s) => {
      asked.push(s);
      return { ok: true, tools: 8, bytes: 14_000, names: 200 };
    },
    "en",
    async () => 1_000
  );
  await printDeliveryNote([{ surface: "codex", mcpSurface: "full" }], async () => {
    throw new Error("boom");
  });
  process.stdout.write = write;
  assert.deepEqual(asked, ["search"]);
  assert.match(out.join(""), /claude-code: MCP lists 8 tools \(surface search\), ~300 tokens at session start/);
  assert.ok(!out.join("").includes("cursor"));
});
