/**
 * #1471 — archived memories come back over MCP/REST (restore_memory) and the
 * CLI (`bastra trash`), not only through the Mac-app bridge and the web UI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, Vault, SearchIndex, saveMemory, type SaveMemoryInput } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { archiveMemoryHandler } from "../src/tool-handlers.js";
import { restoreMemoryHandler } from "../src/restore-memory-handler.js";
import { dispatchApi } from "../src/http-api-routes.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { TRUSTED_LOCAL_APP } from "../src/private-access.js";
import { startHttpServer } from "../src/http.js";
import { cmdTrash } from "../src/cli/trash-cmd.js";
import type { ParsedArgs } from "../src/cli/types.js";
import type { ToolDeps } from "../src/tool-deps.js";

const TOKEN = "test-token-1471-abcdef0123456789";
process.env.BASTRA_API_TOKEN = TOKEN;

async function fixture(t: { after: (fn: () => unknown) => void }) {
  resetAuditLogCache();
  const vaultRoot = await mkdtemp(join(tmpdir(), "bastra-1471-"));
  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultRoot };
  t.after(async () => {
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const seed = async (id: string, over: Partial<SaveMemoryInput> = {}) => {
    const r = await saveMemory(vaultRoot, {
      id,
      title: `Title ${id}`,
      type: "lesson",
      summary: `Summary ${id}.`,
      body: `Body ${id}.\n`,
      topic_path: ["t", "u"],
      tags: ["t"],
      scope: "t",
      recall_when: [`trigger ${id}`],
      ...over,
    } as SaveMemoryInput);
    await vault.reindexFile(r.file_path);
    return r.file_path;
  };
  return { deps, vault, vaultRoot, seed };
}

type Listed = { archived: { id: string; title: string; from: string | null }[]; total: number };

test("#1471 list shows an archived memory, restore puts it back with an audit entry", async (t) => {
  const { deps, vault, vaultRoot, seed } = await fixture(t);
  const path = await seed("kept-lesson");
  const original = await readFile(path, "utf8");
  await archiveMemoryHandler(deps, { id: "kept-lesson" });
  assert.equal(vault.get("kept-lesson"), undefined);

  const listed = (await restoreMemoryHandler(deps, {}, undefined)) as Listed;
  assert.deepEqual(
    listed.archived.map((m) => [m.id, m.title]),
    [["kept-lesson", "Title kept-lesson"]]
  );
  assert.ok(listed.archived[0].from?.endsWith("kept-lesson.md"), listed.archived[0].from ?? "");

  const restored = (await restoreMemoryHandler(deps, { id: "kept-lesson" }, undefined)) as { restored_to: string };
  assert.equal(restored.restored_to, path);
  assert.equal(await readFile(path, "utf8"), original, "the memory comes back byte for byte");
  assert.ok(vault.get("kept-lesson"), "reindexed at once");

  const log = (await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { operation: string; actor: string; actor_detail?: string });
  assert.deepEqual(log.at(-1), {
    ...log.at(-1),
    operation: "restore",
    actor: "assistant",
    actor_detail: "mcp:restore_memory",
  });
  assert.equal(
    ((await restoreMemoryHandler(deps, {}, undefined)) as Listed).archived.length,
    0,
    "nothing left to restore"
  );
});

test("#1471 a private archived memory stays invisible to public transports", async (t) => {
  const { deps, seed } = await fixture(t);
  await seed("secret-note", { sensitivity: "private" });
  await archiveMemoryHandler(deps, { id: "secret-note" }, TRUSTED_LOCAL_APP);
  assert.equal(((await restoreMemoryHandler(deps, {}, undefined)) as Listed).archived.length, 0);
  await assert.rejects(
    () => restoreMemoryHandler(deps, { id: "secret-note" }, undefined),
    /nothing to restore: secret-note/
  );
  const trusted = (await restoreMemoryHandler(deps, {}, TRUSTED_LOCAL_APP)) as Listed;
  assert.deepEqual(
    trusted.archived.map((m) => m.id),
    ["secret-note"]
  );
});

test("#1471 a restore never overwrites a memory that is live again under the id", async (t) => {
  const { deps, vault, seed } = await fixture(t);
  await seed("twice");
  await archiveMemoryHandler(deps, { id: "twice" });
  const second = await seed("twice", { body: "The new version.\n" });
  await assert.rejects(() => restoreMemoryHandler(deps, { id: "twice" }, undefined));
  assert.match(await readFile(second, "utf8"), /The new version\./);
  assert.ok(vault.get("twice"));
});

test("#1471 unknown ids and bad arguments are refused", async (t) => {
  const { deps } = await fixture(t);
  await assert.rejects(() => restoreMemoryHandler(deps, { id: "never-existed" }, undefined), /nothing to restore/);
  await assert.rejects(() => restoreMemoryHandler(deps, { limit: 0 }, undefined), /invalid restore_memory args/);
});

test("#1471 REST dispatch restores and records the writer", async (t) => {
  const { deps, vaultRoot, seed } = await fixture(t);
  await seed("over-rest");
  await archiveMemoryHandler(deps, { id: "over-rest" });
  const out = (await dispatchApi(
    "restore_memory",
    { id: "over-rest" },
    { toolDeps: deps, documentWriteEnabled: false, ccSessionId: "cc-9", transport: "forwarder", client: "codex/1" }
  )) as { id: string };
  assert.equal(out.id, "over-rest");
  const last = JSON.parse(
    (await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8")).trim().split("\n").at(-1)!
  ) as Record<string, unknown>;
  assert.equal(last.operation, "restore");
  assert.equal(last.transport, "forwarder");
  assert.equal(last.client, "codex/1");
  assert.equal(last.caller_session, "cc-9");
});

test("#1471 restore reports an audit write failure after putting the memory back", async (t) => {
  const { deps, vault, seed } = await fixture(t);
  const path = await seed("audit-write-fails");
  const original = await readFile(path, "utf8");
  await archiveMemoryHandler(deps, { id: "audit-write-fails" });
  t.mock.method(AuditLog.prototype, "record", async () => {
    throw Object.assign(new Error("audit write failed"), { code: "EIO" });
  });

  const restored = await restoreMemoryHandler(deps, { id: "audit-write-fails" }, undefined);
  assert.ok("warning" in restored);
  assert.match(restored.warning ?? "", /audit entry could not be written .*do NOT retry/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.ok(vault.get("audit-write-fails"));
});

test("#1471 bastra trash lists and restores through the running daemon", async (t) => {
  const { deps, vault, vaultRoot, seed } = await fixture(t);
  await seed("cli-note");
  await archiveMemoryHandler(deps, { id: "cli-note" });
  const handle = await startHttpServer({
    port: 0,
    vault,
    search: deps.search,
    telemetry: deps.telemetry,
    version: "test-version",
    toolDeps: deps,
    documentWriteEnabled: false,
    onActivity: () => {},
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  const previousUrl = process.env.BASTRA_DAEMON_URL;
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${handle.port}`;
  const printed: string[] = [];
  const log = t.mock.method(console, "log", (line: string) => printed.push(line));
  try {
    const args = (sub: string, ...rest: string[]) =>
      ({ surface: sub, positional: ["trash", sub, ...rest], json: false }) as unknown as ParsedArgs;
    assert.equal(await cmdTrash(args("list")), 0);
    assert.ok(
      printed.some((l) => l.includes("cli-note") && l.includes("Title cli-note")),
      printed.join("\n")
    );
    assert.equal(await cmdTrash(args("restore", "cli-note")), 0);
    assert.ok(vault.get("cli-note"));
    assert.ok((await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8")).includes('"restore"'));
    assert.equal(await cmdTrash(args("restore")), 2, "restore without id prints usage");
  } finally {
    log.mock.restore();
    if (previousUrl === undefined) delete process.env.BASTRA_DAEMON_URL;
    else process.env.BASTRA_DAEMON_URL = previousUrl;
    await handle.close();
  }
});

test("#1471 INV-PRIV: a REST caller can neither list nor restore a private archived memory, nor learn its content", async (t) => {
  const { deps, vault, seed } = await fixture(t);
  const path = await seed("private-diary", { sensitivity: "private", body: "Very personal content.\n" });
  await archiveMemoryHandler(deps, { id: "private-diary" }, TRUSTED_LOCAL_APP);
  const ctx = { toolDeps: deps, documentWriteEnabled: false, ccSessionId: null };
  const listed = (await dispatchApi("restore_memory", {}, ctx)) as Listed;
  assert.equal(JSON.stringify(listed).includes("private-diary"), false);
  assert.equal(listed.total, 0, "not even counted");
  let message = "";
  await assert.rejects(
    async () => dispatchApi("restore_memory", { id: "private-diary" }, ctx),
    (err: Error) => ((message = err.message), true)
  );
  const unknown = await dispatchApi("restore_memory", { id: "never-existed" }, ctx).catch((e: Error) => e.message);
  assert.equal(
    message.replace("private-diary", "X"),
    String(unknown).replace("never-existed", "X"),
    "same answer as for an id that never existed"
  );
  assert.match(message, /^nothing to restore: private-diary/);
  assert.ok(!message.includes("personal"));
  assert.equal(vault.get("private-diary"), undefined, "nothing was restored");
  await assert.rejects(() => readFile(path, "utf8"));
});

test("#1471 a restore over a live private memory answers like a missing one, without its path", async (t) => {
  const { deps, seed } = await fixture(t);
  await seed("shadowed");
  await archiveMemoryHandler(deps, { id: "shadowed" });
  const livePath = await seed("shadowed", { sensitivity: "private" });
  let message = "";
  await assert.rejects(
    async () => restoreMemoryHandler(deps, { id: "shadowed" }, undefined),
    (err: Error) => ((message = err.message), true)
  );
  assert.match(message, /^nothing to restore: shadowed/);
  assert.ok(!message.includes(livePath));
});
