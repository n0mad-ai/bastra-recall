/**
 * #1279 Phase 1: MCP over Streamable HTTP at /api/v1/mcp.
 *
 * The door ChatGPT and Claude connectors reach through a tunnel. It must sit
 * behind the same token gate as the REST tools, list the `write` surface
 * without task tools, and answer tool calls through the shared dispatcher.
 *
 * Runner: `tsx --test __tests__/http-mcp.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

const TOKEN = "test-token-abcdef0123456789";
process.env.BASTRA_API_TOKEN = TOKEN;

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: reference", `summary: ${title}`,
    "topic_path:", "  - test", "tags:", "  - test", "scope: mcp-test",
    "recall_when:", `  - ${title}`, `created: ${ts}`, `updated: ${ts}`, "---",
    "", `Body for ${title}.`, "",
  ].join("\n");
}

function rawPost(port: number, path: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-mcphttp-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test-version",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    onActivity: () => {},
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  try {
    await fn(handle.port!);
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

test("mcp http: a tunnelled caller (public Host) without token is refused", async () => {
  await withServer(async (port) => {
    const status = await rawPost(port, "/api/v1/mcp", { ...MCP_HEADERS, Host: "recall.example.com" }, INIT);
    assert.equal(status, 401, "the remote MCP door must not open without the bearer token");
  });
});

test("mcp http: a tunnelled caller with the token gets through", async () => {
  await withServer(async (port) => {
    const status = await rawPost(
      port,
      "/api/v1/mcp",
      { ...MCP_HEADERS, Host: "recall.example.com", Authorization: `Bearer ${TOKEN}` },
      INIT,
    );
    assert.equal(status, 200);
  });
});

test("mcp http: lists the write surface without tasks and answers a recall", async () => {
  await withServer(async (port) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/v1/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    try {
      assert.match(client.getInstructions() ?? "", /persistent local memory/);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ["recall", "load_memory", "save_memory", "edit_memory", "find_document"]) {
        assert.ok(names.includes(n), `${n} missing from the remote surface`);
      }
      for (const n of ["archive_memory", "move_document", "recategorize_document"]) {
        assert.ok(!names.includes(n), `${n} is lifecycle-shaped and must stay off the remote surface`);
      }
      assert.ok(!names.some((n) => n.startsWith("task_")), "task tools need loopback and cannot work remotely");

      const recalled = await client.callTool({ name: "recall", arguments: { query: "alpha bravo" } });
      assert.notEqual(recalled.isError, true);
      const recallText = (recalled.content as { type: string; text: string }[])[0].text;
      assert.equal((JSON.parse(recallText) as { vault_size: number }).vault_size, 1);

      const loaded = await client.callTool({ name: "load_memory", arguments: { id: "alpha" } });
      assert.notEqual(loaded.isError, true);
      const loadText = (loaded.content as { type: string; text: string }[])[0].text;
      assert.equal((JSON.parse(loadText) as { frontmatter: { title: string } }).frontmatter.title, "alpha bravo");

      const denied = await client.callTool({ name: "archive_memory", arguments: { id: "alpha" } });
      assert.equal(denied.isError, true);
    } finally {
      await client.close();
    }
  });
});

test("mcp http: GET is refused — the stateless door has no event stream", async () => {
  await withServer(async (port) => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/api/v1/mcp", method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 405);
  });
});
