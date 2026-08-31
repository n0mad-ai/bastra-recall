/**
 * Fuzzy-Expansion nach Seltenheit (#362).
 *
 * Zwei Eigenschaften werden hier festgenagelt, weil beide still brechen können:
 *
 * 1. **Default aus.** Ohne `bm25_fuzzy_rare_df_max` muss ein Tippfehler weiter
 *    treffen. Bräche das, verlöre jeder Caller Treffer, ohne dass irgendetwas
 *    fehlschlägt — die Suche liefert einfach weniger.
 * 2. **Der seltene Term behält seine Toleranz.** Genau davon lebt die Variante:
 *    Sie darf nur die Expansion der HÄUFIGEN Wörter streichen. Ein Test, der
 *    bloß „schneller" prüft, würde auch eine Variante durchwinken, die alle
 *    Fuzzy-Treffer verliert.
 *
 * Runner: node --import tsx --test packages/core/__tests__/bm25-expansion.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rareTermFuzzy, BM25_FUZZY, BM25_FUZZY_RARE_DF_MAX } from "../src/bm25-expansion.js";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";

function memoryMd(id: string, marker: string, filler: string): string {
  return `---
id: ${id}
title: ${id}
type: lesson
summary: ${marker} summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["${marker}"]
created: 2020-01-01
updated: 2026-07-01
---

${marker} ${filler}
`;
}

test("no threshold set — rareTermFuzzy stays out of the way", () => {
  assert.equal(rareTermFuzzy(() => 1, undefined), undefined);
  assert.equal(rareTermFuzzy(() => 1, 0), undefined);
  assert.equal(rareTermFuzzy(() => 1, Number.NaN), undefined);
  assert.equal(rareTermFuzzy(() => 1, -5), undefined);
});

test("rare terms keep fuzzy, common terms lose it", () => {
  const fuzzy = rareTermFuzzy((t) => (t === "haeufig" ? 500 : 3), BM25_FUZZY_RARE_DF_MAX);
  assert.ok(fuzzy, "a positive threshold must produce a function");
  assert.equal(fuzzy("selten"), BM25_FUZZY);
  assert.equal(fuzzy("haeufig"), false);
});

test("a term absent from the index counts as rare, not as common", () => {
  // df 0 means "not in the index" — fuzzy is then the ONLY way it can match
  // anything at all, so it must not be treated like a filler word.
  const fuzzy = rareTermFuzzy(() => 0, BM25_FUZZY_RARE_DF_MAX);
  assert.equal(fuzzy?.("unbekannt"), BM25_FUZZY);
});

test("default is off — a typo still matches through fuzzy", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-bm25expand-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  // One rare marker, plus a word repeated across every memory so it is common.
  const filler = "gemeinsam gemeinsam gemeinsam";
  await writeFile(path.join(dir, "a.md"), memoryMd("alpha", "ANCHORWORD", filler), "utf8");
  for (let i = 0; i < 5; i++) {
    await writeFile(path.join(dir, `f${i}.md`), memoryMd(`filler${i}`, "SONSTWORT", filler), "utf8");
  }

  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(() => search.stop());

  // One edit away from ANCHORWORD — reachable only through fuzzy.
  const typo = "anchorwrd";
  const baseline = search.recall(typo, { k: 5 });
  assert.ok(
    baseline.some((h) => h.id === "alpha"),
    "precondition: without a threshold the typo must reach the memory through fuzzy",
  );

  // The rare marker keeps its fuzzy tolerance under the threshold, because its
  // df is far below it — the treatment must not change this hit.
  const treated = search.recall(typo, { k: 5, bm25_fuzzy_rare_df_max: BM25_FUZZY_RARE_DF_MAX });
  assert.ok(
    treated.some((h) => h.id === "alpha"),
    "a RARE term must keep its fuzzy tolerance when the threshold is set",
  );
});
