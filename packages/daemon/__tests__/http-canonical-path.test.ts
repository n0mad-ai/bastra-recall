/**
 * One path view for every gate and every route. The account gate used to read
 * `new URL(...).pathname` while the routers matched the raw target, so a dot
 * segment could make the two disagree. Non-canonical targets are now refused
 * before any gate or handler runs; legitimate encoded paths keep working.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { canonicalRequestTarget } from "../src/http-auth.js";
import { Telemetry } from "../src/telemetry.js";
import { readSettings, mutateSettings, settingsFilePath } from "../src/settings-file.js";

const NON_CANONICAL = [
  "/ui/updates/%2e%2e/%2e%2e/x?since=0",
  "/ui/updates/%2E%2E/%2e%2E/x?since=0",
  "/ui/updates/../../x?since=0",
  "/ui/updates/./x",
  "/ui/fs/%2E%2E/%2e%2e/x",
  "/ui/telemetry/.%2e/.%2E/x",
  "/ui/search/%2e./%2e./x?q=a",
  "/foo/%2e%2e/ui/backdrop",
  "/foo/../ui/health",
  "/x/%2e%2e/api/v1/tasks",
  "//evil/ui/",
  "//evil/ui/updates?since=0",
  "http://127.0.0.1/ui/updates?since=0",
  "/ui\\..\\x",
  "/foo\\..\\ui/updates?since=0",
  "/ui/updates%5c..%5cx",
  "/ui/updates%2f..%2fx",
  "/ui/updates%00",
  "/ui/updates#frag",
  "*",
];

const CANONICAL = [
  "/",
  "/health",
  "/ui",
  "/ui/",
  "/ui/health",
  "/ui/updates?since=0",
  "/ui/updates?since=../../x",
  "/ui/engines/simulation.js",
  "/ui/v22/index.html?q=1",
  "/ui/chat/conversations/Notiz%20mit%20Leerzeichen",
  "/ui/chat/conversations/M%C3%BCller",
  "/ui/files/a.b..c/app.min.js",
  "/ui/files/...",
  "/ui/files/a%2Eb",
  "/api/v1/tasks/task.1:a-b",
  "/api/v1/mcp",
  "/hook/recall",
  "/.well-known/oauth-authorization-server",
];

test("canonical request target: dot segments, host forms, backslashes and encoded separators are refused", () => {
  for (const target of NON_CANONICAL) assert.equal(canonicalRequestTarget(target), false, target);
  for (const target of CANONICAL) assert.equal(canonicalRequestTarget(target), true, target);
  assert.equal(canonicalRequestTarget("/ui/a b"), false, "raw space");
  assert.equal(canonicalRequestTarget("/ui/\u0001"), false, "control character");
  assert.equal(canonicalRequestTarget("/ui/\u007f"), false, "DEL");
  assert.equal(canonicalRequestTarget("/ui/müller"), true, "raw non-ASCII is not a separator");
});

/** Raw HTTP/1.1 so the client sends the target byte for byte (fetch would
 * resolve the dot segments itself). */
function raw(port: number, target: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, body: data.slice(data.indexOf("\r\n\r\n") + 4) });
    });
    socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
}

function memory(id: string, sensitivity: string): string {
  return `---\nid: ${id}\ntitle: Fixture title ${id}\ntype: reference\nsummary: Fixture summary ${id}\ntopic_path: [test]\ntags: [test]\nscope: path-fixture\nrecall_when: [fixture]\nsensitivity: ${sensitivity}\ncreated: 2026-11-16\nupdated: 2026-11-16\n---\nBody ${id}.\n`;
}

test("a foreign account gets no data through any path variant; legitimate paths still route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "http-canonical-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const original = await readSettings();
  await mutateSettings(settingsFilePath(), (s) => ({ ...s, ui: { ...s.ui, enabled: true } }));
  const owner = (await stat(dir)).uid;
  let peer = owner + 1;
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
    localAccount: { platform: "darwin", euid: () => owner, lookup: async () => peer },
  });
  const port = handle.port!;
  try {
    // A fresh private memory lands in the live-update log.
    await writeFile(join(dir, "secret.md"), memory("secret", "private"));
    await vault.reindexFile(join(dir, "secret.md"));
    await new Promise((r) => setTimeout(r, 900));

    for (const target of NON_CANONICAL) {
      const response = await raw(port, target);
      assert.equal(response.status, 400, `${target} → ${response.status}`);
      assert.doesNotMatch(response.body, /Fixture|secret|updates"|minSeq/, target);
    }
    // The canonical address is still guarded for the foreign account.
    assert.equal((await raw(port, "/ui/updates?since=0")).status, 403);
    assert.equal((await raw(port, "/ui/fs")).status, 403);
    assert.equal((await raw(port, "/health")).status, 200);

    peer = owner;
    for (const target of NON_CANONICAL) assert.equal((await raw(port, target)).status, 400, `owner: ${target}`);
    const updates = await raw(port, "/ui/updates?since=0");
    assert.equal(updates.status, 200);
    assert.match(updates.body, /Fixture title secret/, "the proven owner still sees private live entries");
    assert.equal((await raw(port, "/ui/health")).status, 200);
    assert.equal((await raw(port, "/ui/v22/index.html?q=1")).status, 302);
    for (const target of [
      "/ui/chat/conversations/Notiz%20mit%20Leerzeichen",
      "/ui/chat/conversations/M%C3%BCller",
      "/ui/engines/simulation.js",
      "/ui/files/a.b..c/app.min.js",
      "/hook/session-context",
    ])
      assert.notEqual((await raw(port, target)).status, 400, target);
    assert.equal((await raw(port, "/ui/engines/simulation.js")).status, 200);
  } finally {
    await handle.close();
    search.stop();
    await vault.stop();
    await mutateSettings(settingsFilePath(), () => original);
    await rm(dir, { recursive: true, force: true });
  }
});
