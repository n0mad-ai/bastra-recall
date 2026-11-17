/**
 * #1469 — every MCP and HTTP write names its transport, client and client
 * session in the audit entry. A record for tracing, never an access filter:
 * each write below goes through unasked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler } from "../src/save-memory-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { clientLabel, mcpClientLabel, writeCallerStore } from "../src/caller-session.js";
import { registerClient, createGrant } from "../src/oauth-store.js";

const TOKEN = "test-token-1469-abcdef0123456789";
process.env.BASTRA_API_TOKEN = TOKEN;

interface AuditLine {
  memory_id: string;
  actor_detail?: string;
  transport?: string;
  client?: string | null;
  caller_session?: string | null;
}

async function audit(vaultDir: string, id: string): Promise<AuditLine> {
  const raw = await readFile(join(vaultDir, ".bastra", "audit-log.ndjson"), "utf8");
  const lines = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditLine)
    .filter((l) => l.memory_id === id);
  assert.equal(lines.length, 1, raw);
  return lines[0];
}

const memory = (title: string) => ({
  title,
  type: "lesson",
  summary: `${title} summary.`,
  body: `${title} body.\n`,
  topic_path: ["audit", "writer"],
  tags: ["audit"],
  scope: "audit",
  recall_when: [`${title} trigger`],
});

async function withServer(fn: (port: number, vaultDir: string, oauthPath: string) => Promise<void>): Promise<void> {
  resetAuditLogCache();
  const dir = await mkdtemp(join(tmpdir(), "bastra-1469-"));
  const oauthPath = join(dir, "oauth.json");
  process.env.BASTRA_OAUTH_PATH = oauthPath;
  const vaultDir = join(dir, "vault");
  await mkdir(vaultDir);
  const vault = new Vault(vaultDir);
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
    toolDeps: { vault, search, telemetry, vaultPath: vaultDir },
    documentWriteEnabled: false,
    onActivity: () => {},
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  try {
    await fn(handle.port!, vaultDir, oauthPath);
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    resetAuditLogCache();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function rest(port: number, tool: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { id: string };
}

/** `tunnelled`: the call arrives the way a tunnel delivers it (forwarding
 *  header), so the loopback shortcut does not open the door. */
async function remoteSave(port: number, bearer: string, title: string, tunnelled = false): Promise<string> {
  const client = new Client({ name: "remote-test", version: "1" });
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
  if (tunnelled) headers["x-forwarded-for"] = "203.0.113.5";
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/v1/mcp`), { requestInit: { headers } })
  );
  try {
    const out = await client.callTool({ name: "save_memory", arguments: memory(title) });
    assert.notEqual(out.isError, true, JSON.stringify(out));
    return (JSON.parse((out.content as { text: string }[])[0].text) as { id: string }).id;
  } finally {
    await client.close();
  }
}

test("#1469 forwarder: the MCP client and the Claude Code session reach the audit", async () => {
  await withServer(async (port, vaultDir) => {
    const saved = await rest(port, "save_memory", memory("Forwarded"), {
      "x-bastra-client": encodeURIComponent("claude-code/2.1.300"),
      "x-bastra-cc-session": "cc-session-1",
    });
    const line = await audit(vaultDir, saved.id);
    assert.equal(line.actor_detail, "mcp:save_memory");
    assert.equal(line.transport, "forwarder");
    assert.equal(line.client, "claude-code/2.1.300");
    assert.equal(line.caller_session, "cc-session-1");
  });
});

test("#1469 plain HTTP: transport recorded, unknown client and session stay null", async () => {
  await withServer(async (port, vaultDir) => {
    const saved = await rest(port, "save_memory", memory("Direct REST"));
    const line = await audit(vaultDir, saved.id);
    assert.equal(line.transport, "http");
    assert.equal(line.client, null);
    assert.equal(line.caller_session, null);
  });
});

test("#1469 edit and archive over HTTP carry the writer too", async () => {
  await withServer(async (port, vaultDir) => {
    const saved = await rest(port, "save_memory", memory("Edited later"));
    const headers = { "x-bastra-client": encodeURIComponent("codex/0.9") };
    await rest(port, "edit_memory", { id: saved.id, append: "More." }, headers);
    await rest(port, "archive_memory", { id: saved.id }, headers);
    const raw = await readFile(join(vaultDir, ".bastra", "audit-log.ndjson"), "utf8");
    const lines = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditLine);
    const later = lines.filter((l) => l.memory_id === saved.id).slice(1);
    assert.equal(later.length, 2, raw);
    for (const line of later) {
      assert.equal(line.transport, "forwarder");
      assert.equal(line.client, "codex/0.9");
    }
  });
});

test("#1469 remote MCP with an OAuth token names the registered client", async () => {
  await withServer(async (port, vaultDir, oauthPath) => {
    const client = await registerClient(
      { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"] },
      oauthPath
    );
    const grant = await createGrant(
      { client_id: client!.client_id, resource: `http://127.0.0.1:${port}/api/v1/mcp`, scope: "memory" },
      oauthPath
    );
    const id = await remoteSave(port, grant!.tokens.access_token, "Remote OAuth", true);
    const line = await audit(vaultDir, id);
    assert.equal(line.transport, "mcp-http");
    assert.equal(line.client, `ChatGPT [${client!.client_id}]`);
    assert.equal(line.caller_session, null);
  });
});

test("#1469 remote MCP with the API token: transport recorded, no client claimed", async () => {
  await withServer(async (port, vaultDir) => {
    const id = await remoteSave(port, TOKEN, "Remote token");
    const line = await audit(vaultDir, id);
    assert.equal(line.transport, "mcp-http");
    assert.equal(line.client, null);
  });
});

test("#1469 stdio: a write inside the stdio call context is audited with that context", async () => {
  resetAuditLogCache();
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-1469-stdio-"));
  const vault = new Vault(vaultDir);
  await vault.init();
  const search = new SearchIndex(vault);
  try {
    const deps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultDir };
    const writer = {
      transport: "stdio" as const,
      client: mcpClientLabel({ name: "claude-desktop", version: "1.0" }),
      session: null,
    };
    const saved = await writeCallerStore.run(writer, () => saveMemoryHandler(deps, memory("Stdio")));
    const line = await audit(vaultDir, (saved as { id: string }).id);
    assert.equal(line.transport, "stdio");
    assert.equal(line.client, "claude-desktop/1.0");
    assert.equal(line.caller_session, null);
  } finally {
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#1469 a write outside any tool call keeps the old entry shape", async () => {
  resetAuditLogCache();
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-1469-plain-"));
  const vault = new Vault(vaultDir);
  await vault.init();
  try {
    const deps = { vault, search: new SearchIndex(vault), telemetry: new Telemetry(), vaultPath: vaultDir };
    const saved = await saveMemoryHandler(deps, memory("No caller"));
    const line = await audit(vaultDir, (saved as { id: string }).id);
    assert.ok(!("transport" in line) && !("client" in line) && !("caller_session" in line), JSON.stringify(line));
  } finally {
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#1469 client labels are one bounded line", () => {
  assert.equal(clientLabel("evil\nclient‮  name"), "evil client name");
  assert.equal(clientLabel("x".repeat(500))?.length, 160);
  assert.equal(clientLabel(""), null);
  assert.equal(clientLabel(undefined), null);
  assert.equal(mcpClientLabel(undefined), null);
  assert.equal(mcpClientLabel({ name: "cursor" }), "cursor");
});
