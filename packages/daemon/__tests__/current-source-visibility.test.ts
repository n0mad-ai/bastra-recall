/**
 * #1334 — direct MCP readers (recall, load_memory) apply the CURRENT source
 * visibility, not the indexed one. The index is left stale on purpose (no
 * watcher), the file on disk changes underneath it. Invented fixtures only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, memoryRevision } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, loadMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { TRUSTED_LOCAL_APP } from "../src/private-access.js";

const ID = "stale-visibility-fixture";
const memory = (extra = "", body = "Invented fixture body about lantern quarry routes.") => [
  "---", `id: ${ID}`, "title: lantern quarry routes", "type: lesson", "summary: lantern quarry routes summary",
  "topic_path:", "  - fixture", "tags:", "  - fixture", "scope: fixture", ...(extra ? [extra] : []),
  "recall_when:", "  - lantern quarry routes", "created: 2026-11-01T00:00:00.000Z", "updated: 2026-11-01T00:00:00.000Z",
  "---", "", body, "",
].join("\n");

async function staleDeps() {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1334-"));
  const file = join(dir, `${ID}.md`);
  await writeFile(file, memory(), "utf8");
  const vault = new Vault(dir);
  await vault.init(); // no startWatching(): the index stays as indexed
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return { deps, file, close: async () => { search.stop(); await rm(dir, { recursive: true, force: true }); } };
}

const hidden = async (deps: ToolDeps) => {
  await assert.rejects(loadMemoryHandler(deps, { id: ID }), /memory not found/);
  const res = await recallHandler(deps, { query: "lantern quarry routes" });
  assert.equal(res.hits.some((h: { id: string }) => h.id === ID), false, "recall must not project the stale public hit");
};

test("#1334: public in the index, private on disk -> hidden from untrusted recall and load_memory", async () => {
  const { deps, file, close } = await staleDeps();
  try {
    assert.equal((await loadMemoryHandler(deps, { id: ID })).id, ID, "public memory still loads");
    await writeFile(file, memory("sensitivity: private"), "utf8");
    await hidden(deps);
    assert.equal((await loadMemoryHandler(deps, { id: ID }, TRUSTED_LOCAL_APP)).id, ID, "trusted local access unchanged");
  } finally { await close(); }
});

test("#1334: a missing source fails closed for untrusted callers", async () => {
  const { deps, file, close } = await staleDeps();
  try {
    await unlink(file);
    await hidden(deps);
  } finally { await close(); }
});

test("#1334: an unparseable source fails closed for untrusted callers", async () => {
  const { deps, file, close } = await staleDeps();
  try {
    await writeFile(file, "---\nid: [unterminated\nsensitivity: private\n---\nbody\n", "utf8");
    await hidden(deps);
  } finally { await close(); }
});

test("#1334: a changed source never pairs its revision with the stale indexed body", async () => {
  const { deps, file, close } = await staleDeps();
  try {
    const indexed = memoryRevision(memory());
    const changed = memory("", "Invented fixture body, rewritten on disk.");
    await writeFile(file, changed, "utf8");
    const res = await loadMemoryHandler(deps, { id: ID });
    assert.match(res.body, /lantern quarry routes/, "the indexed body is what was delivered");
    assert.notEqual(res.revision, memoryRevision(changed), "the disk revision belongs to a body that was not delivered");
    assert.equal(res.revision, indexed);
  } finally { await close(); }
});
