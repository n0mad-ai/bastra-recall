/**
 * #164 — the write path for supersession.
 *
 * This is the V2 preparation, not the V2 feature. The V1→V2 contract (C-059)
 * settles the direction: `SUPERSEDE` is NOT today's `archive_memory`, and
 * "historicity comes from the version status, not from a change of location".
 * A predecessor that gets moved to the trash is not historical — it is gone,
 * and the contract requires old versions to stay citable.
 *
 * So this stage builds exactly one thing: the DATA. A directed version edge
 * that both sides carry, with the predecessor left in the living vault. What
 * reads it later — the Historical zone, deep recall, the broken node pointing
 * at its successor in the mindspace — is V2 and deliberately absent here.
 *
 * These tests are therefore mostly about what does NOT happen: no trash, no
 * de-indexing, no `obsolete`. #1206 adds ranking below a retrieved successor
 * while preserving the predecessor's reachability.
 *
 * Runner: `tsx --test __tests__/supersede-write-path.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { saveMemoryHandler, loadMemoryHandler, recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

async function makeDeps(): Promise<{ deps: ToolDeps; vaultPath: string; cleanup: () => Promise<void> }> {
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-supersede-"));
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath };
  return {
    deps,
    vaultPath,
    cleanup: async () => {
      search.stop();
      await vault.stop?.();
      await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

const memo = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "project-fact",
  summary: `Zusammenfassung für ${title}`,
  body: `Inhalt von ${title}.`,
  topic_path: ["test"],
  tags: ["test"],
  scope: "testproj",
  recall_when: [`wenn ${title} gebraucht wird`],
  ...extra,
});

async function frontmatterOf(vaultPath: string, deps: ToolDeps, id: string): Promise<Record<string, unknown>> {
  const mem = deps.vault.get(id);
  assert.ok(mem, `memory ${id} is not in the living vault`);
  const raw = await readFile(mem!.filePath, "utf8");
  return matter(raw).data as Record<string, unknown>;
}

test("#164: the edge is written on BOTH sides", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const old = await saveMemoryHandler(deps, memo("Alte Fassung"));
    const fresh = await saveMemoryHandler(deps, memo("Neue Fassung", { replaces: old.id }));

    const successor = await frontmatterOf(vaultPath, deps, fresh.id);
    assert.equal(successor.replaces, old.id, "the successor must record what it replaces");

    const predecessor = await frontmatterOf(vaultPath, deps, old.id);
    assert.equal(predecessor.superseded_by, fresh.id, "the predecessor must point at its successor");
  } finally {
    await cleanup();
  }
});

test("#164: the predecessor stays in the LIVING vault — not trashed, not de-indexed", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const old = await saveMemoryHandler(deps, memo("Bleibt da"));
    const oldPath = deps.vault.get(old.id)!.filePath;
    await saveMemoryHandler(deps, memo("Nachfolger", { replaces: old.id }));

    // This is the whole point of C-059 — the contrast with archive_memory.
    assert.ok(deps.vault.get(old.id), "the predecessor must still be in the index");
    assert.equal(deps.vault.get(old.id)!.filePath, oldPath, "its file must not have moved");

    const trashDir = join(vaultPath, ".bastra", "trash");
    const trashed = await readdir(trashDir).catch(() => [] as string[]);
    assert.equal(trashed.length, 0, `nothing may be trashed, found: ${trashed.join(", ")}`);
  } finally {
    await cleanup();
  }
});

test("#164: the predecessor is NOT marked obsolete — that would hide it from every path", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const old = await saveMemoryHandler(deps, memo("Nicht obsolet"));
    await saveMemoryHandler(deps, memo("Nachfolger", { replaces: old.id }));

    const predecessor = await frontmatterOf(vaultPath, deps, old.id);
    assert.equal(predecessor.obsolete, undefined, "obsolete would remove it from recall with no way back in");
  } finally {
    await cleanup();
  }
});

test("#164: an old version still resolves by id — old citations keep working", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const old = await saveMemoryHandler(deps, memo("Zitierbar"));
    const fresh = await saveMemoryHandler(deps, memo("Nachfolger", { replaces: old.id }));

    const loaded = await loadMemoryHandler(deps, { id: old.id });
    assert.equal(loaded.frontmatter.id, old.id);
    assert.equal(
      loaded.frontmatter.superseded_by,
      fresh.id,
      "loading an old version must reveal that a newer one exists",
    );
  } finally {
    await cleanup();
  }
});

test("#1206: the successor ranks ahead while the predecessor stays retrievable", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const old = await saveMemoryHandler(deps, memo("Rangfrage"));
    const fresh = await saveMemoryHandler(deps, memo("Nachfolger Rangfrage", { replaces: old.id }));

    // min_score: 0 because a two-memory vault produces BM25 scores far below
    // the default noise floor — without it this would assert on the floor, not
    // on supersession.
    const res = await recallHandler(deps, { query: "Rangfrage", k: 10, min_score: 0 });
    const hits = res.hits as Array<{ id: string; score: number }>;
    const predecessor = hits.find((h) => h.id === old.id);
    assert.ok(
      predecessor,
      "the predecessor must still be retrievable after the ranking correction",
    );
    const successor = hits.find((h) => h.id === fresh.id);
    assert.ok(successor, "sanity: the successor is in the index too");
    assert.ok(
      predecessor!.score < successor!.score,
      `predecessor ${predecessor!.score} must rank below successor ${successor!.score}`,
    );
    assert.ok(hits.indexOf(successor!) < hits.indexOf(predecessor!));
    const loaded = await loadMemoryHandler(deps, { id: old.id });
    assert.equal(loaded.frontmatter.id, old.id);
  } finally {
    await cleanup();
  }
});

test("#164: replaces must point at something that exists", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    await assert.rejects(
      () => saveMemoryHandler(deps, memo("Zeigt ins Leere", { replaces: "gibt-es-nicht" })),
      /unknown memory 'gibt-es-nicht'/,
    );
  } finally {
    await cleanup();
  }
});

test("#164: a memory cannot supersede itself", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    const first = await saveMemoryHandler(deps, memo("Selbstbezug"));
    await assert.rejects(
      () => saveMemoryHandler(deps, memo("Selbstbezug", { replaces: first.id, overwrite: true })),
      /cannot supersede itself/,
    );
  } finally {
    await cleanup();
  }
});

test("#164: a failed edge is never silent — nothing written, error surfaced", async () => {
  const { deps, cleanup } = await makeDeps();
  try {
    // The predecessor check runs BEFORE the write, so a bad edge costs nothing.
    await assert.rejects(() => saveMemoryHandler(deps, memo("Abbruch", { replaces: "fehlt" })));
    assert.equal(deps.vault.get("abbruch"), undefined, "a rejected save must not leave the memory behind");
  } finally {
    await cleanup();
  }
});

test("#164: re-saving a superseded memory keeps its edge", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const old = await saveMemoryHandler(deps, memo("Wird ersetzt"));
    const fresh = await saveMemoryHandler(deps, memo("Ersetzt", { replaces: old.id }));

    // Editing the old version afterwards must not drop the version link —
    // save.ts rebuilds the whole frontmatter on every write.
    await saveMemoryHandler(deps, memo("Wird ersetzt", { overwrite: true, body: "Korrigierter Inhalt." }));
    const predecessor = await frontmatterOf(vaultPath, deps, old.id);
    assert.equal(predecessor.superseded_by, fresh.id, "the edge must survive an ordinary overwrite");
  } finally {
    await cleanup();
  }
});

test("#164: a chain of three keeps every link — the data V2 needs to walk", async () => {
  const { deps, vaultPath, cleanup } = await makeDeps();
  try {
    const v1 = await saveMemoryHandler(deps, memo("Version eins"));
    const v2 = await saveMemoryHandler(deps, memo("Version zwei", { replaces: v1.id }));
    const v3 = await saveMemoryHandler(deps, memo("Version drei", { replaces: v2.id }));

    assert.equal((await frontmatterOf(vaultPath, deps, v1.id)).superseded_by, v2.id);
    const middle = await frontmatterOf(vaultPath, deps, v2.id);
    assert.equal(middle.replaces, v1.id);
    assert.equal(middle.superseded_by, v3.id, "the middle version carries both directions");
    assert.equal((await frontmatterOf(vaultPath, deps, v3.id)).replaces, v2.id);
    assert.equal((await frontmatterOf(vaultPath, deps, v3.id)).superseded_by, undefined, "the tip has no successor");
  } finally {
    await cleanup();
  }
});
