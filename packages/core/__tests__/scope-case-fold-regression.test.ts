/**
 * Regression tests for #360-Folgefund A: `opts.scope` in the BM25-, Vector-
 * und Hop-Expansions-Pfad verglich case-sensitiv gegen `mem.fm.scope`. Ein
 * Recall mit `scope: "CarNexus"` (`detectProject()`'s roher Ordnername) fand
 * dadurch KEIN Memory mit `scope: carnexus` (Vault-Konvention: klein) —
 * genau das Muster, das `session-lane.ts` als SessionStart-Projektquery
 * fährt. Ohne den Fix in `search.ts` (scopeEquals statt `!==`) ist jeder Test
 * hier rot.
 *
 * Runner: node --import tsx --test packages/core/__tests__/scope-case-fold-regression.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";

/** Provider, das für jeden Text denselben Vektor liefert — genügt, um den
 *  Vector-Arm überhaupt Kandidaten liefern zu lassen; die Ähnlichkeit selbst
 *  ist für diesen Test irrelevant, nur ob der Scope-Filter danach durchlässt. */
class ConstantProvider implements EmbeddingProvider {
  readonly id = "const-mock";
  readonly dim = 3;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

function memo(
  id: string,
  title: string,
  scope: string,
  recallWhen: string,
  relatedVia?: { id: string; reason: string; score: number }[],
): string {
  const ts = new Date().toISOString();
  const lines = [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    `scope: ${scope}`,
    "recall_when:",
    `  - ${recallWhen}`,
  ];
  if (relatedVia?.length) {
    lines.push("related_via:");
    for (const r of relatedVia) {
      lines.push(`  - id: ${r.id}`, `    reason: ${r.reason}`, `    score: ${r.score}`);
    }
  }
  lines.push(`created: ${ts}`, `updated: ${ts}`, "---", "", `Body for ${title}.`, "");
  return lines.join("\n");
}

test("BM25 path: scope 'CarNexus' finds a memory scoped 'carnexus'", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-scope-fold-bm25-"));
  await writeFile(
    path.join(dir, "m1.md"),
    memo("m1", "deploy pipeline note", "carnexus", "carnexus deploy pipeline trigger"),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  try {
    const hits = idx.recall("carnexus deploy pipeline", { scope: "CarNexus", k: 5 });
    assert.ok(
      hits.some((h) => h.id === "m1"),
      "a capitalised scope filter must still find the project's own (lowercase-scoped) memory",
    );
  } finally {
    idx.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Hop-expansion path: a neighbour scoped 'carnexus' survives a 'CarNexus' filter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-scope-fold-hop-"));
  // Seed matches the query directly; its related_via neighbour carries the
  // scope under test and would NEVER match the query text itself.
  await writeFile(
    path.join(dir, "seed.md"),
    memo("seed", "seed memory", "carnexus", "hop seed trigger phrase", [
      { id: "neighbor", reason: "same investigation", score: 0.9 },
    ]),
    "utf8",
  );
  await writeFile(
    path.join(dir, "neighbor.md"),
    memo("neighbor", "neighbour memory", "carnexus", "unrelated neighbour phrase"),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  try {
    const hits = idx.recall("hop seed trigger", { scope: "CarNexus", k: 5, expand_hops: 1 });
    assert.ok(
      hits.some((h) => h.id === "neighbor"),
      "the related_via neighbour must survive the folded scope filter too",
    );
  } finally {
    idx.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Vector-arm path: scope 'CarNexus' finds a memory scoped 'carnexus'", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-scope-fold-vec-"));
  await writeFile(
    path.join(dir, "m1.md"),
    memo("m1", "vector arm probe", "carnexus", "vector arm probe trigger"),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  const emb = new EmbeddingIndex(vault, new ConstantProvider(), path.join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  idx.useEmbeddings(emb);
  try {
    const hits = await idx.recallHybrid("vector arm probe trigger", { scope: "CarNexus", k: 5 });
    assert.ok(
      hits.some((h) => h.id === "m1"),
      "the dense arm's own scope filter must fold case too, not just BM25's",
    );
  } finally {
    await emb.stop();
    idx.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
