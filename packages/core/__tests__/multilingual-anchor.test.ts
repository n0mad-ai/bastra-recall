/**
 * #707: `anchorStrength`'s significance rule does not depend on a language
 * list. PHRASE_STOPWORDS knows de and en; for every other language no word is
 * dropped as a function word (the neutral path), so two exact trigger terms
 * make a strong anchor in Russian, Turkish and Greek exactly as in German.
 *
 * Runner: node --import tsx --test packages/core/__tests__/multilingual-anchor.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { PHRASE_STOPWORDS, PHRASE_STOPWORDS_BY_LANGUAGE } from "../src/stopwords.js";

async function vaultWith(entries: { id: string; recall_when: string[] }[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-ml-anchor-"));
  for (const e of entries) {
    await writeFile(
      path.join(dir, `${e.id}.md`),
      `---
id: ${e.id}
title: ${e.id}
type: lesson
summary: summary of ${e.id}
topic_path: [t]
tags: [t]
scope: t
recall_when: [${e.recall_when.map((r) => JSON.stringify(r)).join(", ")}]
created: 2020-01-01
updated: 2026-07-01
---

body of ${e.id}
`,
      "utf8",
    );
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  return { dir, search };
}

test("the stopword set is the union of the per-language data", () => {
  const union = new Set(Object.values(PHRASE_STOPWORDS_BY_LANGUAGE).flat());
  assert.deepEqual([...PHRASE_STOPWORDS].sort(), [...union].sort());
});

for (const [lang, phrase, query] of [
  ["ru", "перезапуск сервера после обновления", "перезапуск сервера"],
  ["tr", "veritabanı şifresi sıfırlama", "veritabanı şifresi"],
  ["el", "επανεκκίνηση διακομιστή μετά την ενημέρωση", "επανεκκίνηση διακομιστή"],
] as const) {
  test(`#707 ${lang}: two exact trigger terms make a strong anchor without a stopword list`, async (t) => {
    const { dir, search } = await vaultWith([
      { id: "target", recall_when: [phrase] },
      { id: "filler", recall_when: ["something else entirely"] },
    ]);
    t.after(async () => {
      search.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const hit = search.recall(query, { k: 5 }).find((h) => h.id === "target");
    assert.ok(hit, `${lang} query finds its memory`);
    assert.equal(hit.matched_recall_when, true);
    assert.equal(hit.anchor_strength, "strong");
  });
}
