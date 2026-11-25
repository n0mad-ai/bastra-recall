import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("a forwarder response formatting failure still returns an MCP error with text", async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    const depth = 20_000;
    res.end(req.url === "/health" ? '{"ok":true}' : "[".repeat(depth) + "null" + "]".repeat(depth));
  });
  const client = new Client({ name: "forwarder-error-test", version: "1" });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", resolve("packages/daemon/src/mcp-forwarder.ts")],
        env: {
          ...process.env,
          BASTRA_DAEMON_URL: `http://127.0.0.1:${address.port}`,
          BASTRA_FORWARDER_SPAWN: "0",
          BASTRA_MCP_SESSION_CONTEXT: "0",
        } as Record<string, string>,
      })
    );
    const result = await client.callTool({ name: "load_memory", arguments: { id: "fixture" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "Maximum call stack size exceeded" }]);
  } finally {
    await client.close();
    server.close();
  }
});
