/**
 * #1309 — `validate_artifact` is on the write and full surfaces (not search),
 * and a call through the real HTTP daemon and MCP forwarder returns the
 * copy-blocks result with a receipt. `review_draft` stays listed beside it.
 *
 * Revert-check: drop "validate_artifact" from WRITE_SURFACE_TOOLS — the
 * surface case and the forwarder listing go red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Vault, SearchIndex, validateCopyBlocks } from "@bastra-recall/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { ALL_TOOL_DEFS, filterToolDefsForSurface, isToolAllowed } from "../src/tool-defs.js";
import { validateArtifactHandler } from "../src/validate-artifact-handler.js";

const MESSAGE = "Hi Sam,\n\nthe invented package arrives on Tuesday.\nPlease confirm the address.";

test("validate_artifact is on the write and full surfaces, not on search", () => {
  for (const surface of ["write", "full"] as const) {
    assert.ok(filterToolDefsForSurface(ALL_TOOL_DEFS, surface).some((d) => d.name === "validate_artifact"), surface);
    assert.ok(isToolAllowed("validate_artifact", surface));
  }
  assert.equal(isToolAllowed("validate_artifact", "search"), false);
  assert.ok(isToolAllowed("review_draft", "write"), "review_draft stays on write");
});

test("the handler returns the core result plus labels rendered outside the payload", async () => {
  const out = await validateArtifactHandler({ text: MESSAGE, channel: "discord-dm", normalize: "none" });
  const { rendered, session_known, receipt_stored, receipt_note, ...result } = out as typeof out & { receipt_note?: string };
  assert.deepEqual(result, validateCopyBlocks({ text: MESSAGE, channel: "discord-dm", normalize: "none" }));
  assert.match(rendered, /^Block 1\/1 · \d+ max\(codepoints,utf16\)\n```\n/);
  // #1310: stdio — no session, so the receipt is returned but not stored.
  assert.deepEqual([session_known, receipt_stored, typeof receipt_note], [false, false, "string"]);
  await assert.rejects(() => validateArtifactHandler({ text: MESSAGE, channel: "discord-dm", normalize: "nfc" }));
});

test("the handler cannot weaken Discord's unverified counting fallback", async () => {
  const out = await validateArtifactHandler({ text: "😀 ".repeat(1000) + "😀", channel: "discord-dm", unit: "codepoints", normalize: "none" });
  assert.equal(out.unit_applied, "max(codepoints,utf16)");
  assert.ok(out.blocks.every((b) => b.payload.length <= 2000));
  assert.ok(out.receipt);
});

test("round trip through the HTTP daemon and the MCP forwarder on the write surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "validate-artifact-"));
  const root = join(dir, "vault");
  await mkdir(root);
  const prevToken = process.env.BASTRA_API_TOKEN;
  process.env.BASTRA_API_TOKEN = "fixture-validate-token-12345";
  const vault = new Vault(root);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "fixture",
    toolDeps: { vault, search, vaultPath: root, telemetry } as never,
    documentWriteEnabled: false, onActivity: () => {},
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  let client: Client | undefined;
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    client = new Client({ name: "validate-fixture", version: "1" }, { capabilities: {} });
    const env = Object.fromEntries(
      Object.entries({ ...process.env, BASTRA_DAEMON_URL: base, BASTRA_FORWARDER_SPAWN: "0", BASTRA_TOOL_SURFACE: "write" })
        .filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("packages/daemon/dist/mcp-forwarder.js")], env, stderr: "pipe" }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("validate_artifact"));
    assert.ok(names.includes("review_draft"));

    const args = { text: MESSAGE, channel: "discord-dm", limit: 40, unit: "codepoints" as const, normalize: "none" as const, task: { kind: "translate-only", generation: 1 } };
    const answered = await client.callTool({ name: "validate_artifact", arguments: args });
    assert.ok(!answered.isError, JSON.stringify(answered));
    const body = JSON.parse((answered.content as { text: string }[])[0]!.text);
    assert.equal(body.blocks.length, 3);
    assert.equal(body.reconstruction_ok, true);
    assert.equal(body.receipt, validateCopyBlocks(args).receipt);
    assert.match(body.receipt, /^sha256:[0-9a-f]{64}$/);

    const quoted = await client.callTool({ name: "validate_artifact", arguments: { ...args, text: "> " + MESSAGE } });
    const failed = JSON.parse((quoted.content as { text: string }[])[0]!.text);
    assert.equal(failed.receipt, null);
    assert.ok(failed.errors.some((e: { code: string }) => e.code === "quote_prefix"));
  } finally {
    await client?.close();
    await handle.close();
    search.stop();
    await vault.stop();
    if (prevToken === undefined) delete process.env.BASTRA_API_TOKEN; else process.env.BASTRA_API_TOKEN = prevToken;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
