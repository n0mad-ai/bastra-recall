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
import { AuditLog, Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import type { ToolDeps } from "../src/tool-deps.js";
import { archiveMemoryHandler } from "../src/tool-handlers.js";

const TOKEN = "test-token-abcdef0123456789";
process.env.BASTRA_API_TOKEN = TOKEN;

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: mcp-test",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
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

async function withServer(
  fn: (port: number, deps: ToolDeps) => Promise<void>,
  documentWriteEnabled = false
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-mcphttp-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const toolDeps = { vault, search, telemetry, vaultPath: dir };
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test-version",
    toolDeps,
    documentWriteEnabled,
    onActivity: () => {},
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  try {
    await fn(handle.port!, toolDeps);
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
      INIT
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
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/v1/mcp",
          method: "GET",
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 405);
  });
});

test("#1471: write clients can list and restore archived memories over MCP", async () => {
  await withServer(async (port, deps) => {
    await archiveMemoryHandler(deps, { id: "alpha" });
    assert.equal(deps.vault.get("alpha"), undefined);

    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/v1/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      })
    );
    try {
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === "restore_memory"));
      for (const surface of ["search", "write"]) {
        const response = await fetch(`http://127.0.0.1:${port}/tools?surface=${surface}`);
        assert.equal(response.status, 200);
        const { tools } = (await response.json()) as { tools: { name: string }[] };
        assert.equal(
          tools.some((tool) => tool.name === "restore_memory"),
          surface === "write"
        );
      }
      const listed = await client.callTool({ name: "restore_memory", arguments: {} });
      assert.notEqual(listed.isError, true);
      const listText = (listed.content as { type: string; text: string }[])[0].text;
      assert.deepEqual(
        (JSON.parse(listText) as { archived: { id: string }[] }).archived.map((memory) => memory.id),
        ["alpha"]
      );

      const restored = await client.callTool({ name: "restore_memory", arguments: { id: "alpha" } });
      assert.notEqual(restored.isError, true);
      assert.equal(deps.vault.get("alpha")?.fm.title, "alpha bravo");
      const last = (await new AuditLog(deps.vaultPath).readAll()).at(-1);
      assert.equal(last?.operation, "restore");
      assert.equal(last?.memory_id, "alpha");
    } finally {
      await client.close();
    }
  });
});

// #1458: both doors list exactly the document write tools the daemon accepts.
// `GET /tools` is what the stdio forwarder hands its client; /api/v1/mcp is
// the remote door. Without BASTRA_DOCUMENT_WRITE the daemon refuses every
// write call, so neither may list one.
async function listedOnBothDoors(port: number): Promise<{ local: string[]; remote: string[] }> {
  const resp = await fetch(`http://127.0.0.1:${port}/tools?surface=full`);
  const local = ((await resp.json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/v1/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
  );
  try {
    return { local, remote: (await client.listTools()).tools.map((t) => t.name) };
  } finally {
    await client.close();
  }
}

test("INV-CONTRACT-02: #1458: without document write, neither /tools nor the remote door lists a document write tool", async () => {
  await withServer(async (port) => {
    const { local, remote } = await listedOnBothDoors(port);
    assert.ok(local.includes("find_document") && remote.includes("find_document"));
    for (const n of ["save_document", "recategorize_document", "move_document"]) {
      assert.ok(!local.includes(n), `${n} listed on /tools although the daemon refuses it`);
      assert.ok(!remote.includes(n), `${n} listed remotely although the daemon refuses it`);
    }
  });
});

test("#1458: with document write on, /tools lists all three and the remote door its write-surface share", async () => {
  await withServer(async (port) => {
    const { local, remote } = await listedOnBothDoors(port);
    for (const n of ["save_document", "recategorize_document", "move_document"]) {
      assert.ok(local.includes(n), `${n} missing from /tools`);
    }
    assert.ok(remote.includes("save_document"), "save_document belongs to the write surface");
  }, true);
});
