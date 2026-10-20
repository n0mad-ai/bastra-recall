/**
 * #1194 — a query word LONGER than the stored form.
 *
 * MiniSearch matches a query term as a prefix of stored terms, plus fuzzy
 * edits. Turkish "şablonlarında" against a note that says "şablonu", or
 * Finnish "skriptillä" against "skripti", reached nothing: the ending is
 * longer than the fuzzy budget and prefix runs the other way. The lexical
 * arm now adds affix-family stems of an UNINDEXED query word as prefix-only
 * terms at 0.3 of the word's weight. The stems are not query terms: anchor
 * and authored-term checks are unchanged.
 *
 * Runner: node --import tsx --test packages/core/__tests__/query-stems.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { QUERY_STEMS_MAX, QUERY_STEMS_PER_WORD, SearchIndex } from "../src/search.js";
import { queryStems } from "../src/word-form.js";
import { foldTerm } from "../src/fold.js";

function md(id: string, opts: { recallWhen: string; body: string }): string {
  return `---
id: ${id}
title: note ${id}
type: lesson
summary: plain summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["${opts.recallWhen}"]
created: 2026-01-01
updated: 2026-07-01
---

${opts.body}
`;
}

async function withVault(
  notes: Record<string, { recallWhen: string; body: string }>,
  run: (search: SearchIndex) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-stems-"));
  try {
    for (const [id, note] of Object.entries(notes)) await writeFile(path.join(dir, `${id}.md`), md(id, note));
    const vault = new Vault(dir);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    try {
      await run(search);
    } finally {
      search.stop();
      await vault.stop?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const NOTES = {
  turkish: { recallWhen: "şablonu", body: "Müşteri şablonu burada kayıtlı." },
  finnish: { recallWhen: "varmuuskopio", body: "Tämä skripti ajaa varmuuskopion joka yö." },
  other: { recallWhen: "deploy", body: "Nothing about templates or scripts here." },
};

test("queryStems: closed affix families only, seven letters up, stems keep five", () => {
  assert.deepEqual(queryStems("şablonlarında"), ["şablon", "şablonların", "şablonlarınd"]);
  assert.deepEqual(queryStems("skriptillä"), ["skripti"]);
  assert.deepEqual(queryStems("deploying"), ["deploy"]);
  assert.deepEqual(queryStems("скриптами"), ["скрипт", "скриптам"]);
  // Six letters: the endings are the word.
  assert.deepEqual(queryStems("skript"), []);
  assert.deepEqual(queryStems("folder"), []);
  // Digits or punctuation: an identifier, never inflected.
  assert.deepEqual(queryStems("skripti42"), []);
  assert.deepEqual(queryStems("recall63config"), []);
  assert.deepEqual(queryStems("my-app.config"), []);
  // An ending the families do not know is not cut: no arbitrary tails.
  assert.deepEqual(queryStems("telemetry"), []);
});

test("a Turkish query word longer than the stored form finds the note", async () => {
  await withVault(NOTES, (search) => {
    const hits = search.recall("faturanın şablonlarında");
    assert.deepEqual(hits.map((h) => h.id), ["turkish"]);
  });
});

test("a Finnish query word longer than the stored form finds the note", async () => {
  await withVault(NOTES, (search) => {
    const hits = search.recall("skriptillä");
    assert.deepEqual(hits.map((h) => h.id), ["finnish"]);
  });
});

test("stems are not query terms: the anchor checks see the authored words only", async () => {
  await withVault(NOTES, (search) => {
    const viaStem = search.recall("faturanın şablonlarında");
    assert.equal(viaStem.length, 1);
    assert.equal(viaStem[0].matched_recall_when, false, "a stem match is not a trigger match");
    assert.equal(viaStem[0].anchor_strength, undefined);
    const literal = search.recall("şablonu");
    assert.equal(literal[0].id, "turkish");
    assert.equal(literal[0].matched_recall_when, true, "the literal trigger word still anchors");
  });
});

test("an indexed query word gets no stems, and bm25_no_fuzzy gets none either", async () => {
  await withVault(
    { ...NOTES, inflected: { recallWhen: "ajo", body: "Ajo skriptillä onnistui eilen." } },
    (search) => {
      // "skriptillä" is in the index now: the word matches as before, the
      // stem "skripti" is not asked for, so the "finnish" note stays out.
      assert.deepEqual(search.recall("skriptillä").map((h) => h.id), ["inflected"]);
    },
  );
  await withVault(NOTES, (search) => {
    assert.deepEqual(search.recall("skriptillä", { bm25_no_fuzzy: true }), []);
  });
});

/** The lexical plan's term list, stems included — the only place the cap shows. */
function planTerms(search: SearchIndex, query: string): string[] {
  const plan = (search as unknown as { bm25Plan(q: string, o: object): { lexQuery: string } }).bm25Plan(query, {});
  return plan.lexQuery.split(" ");
}

test("stems are capped per word (shortest first) and per query", async () => {
  await withVault(NOTES, (search) => {
    assert.equal(QUERY_STEMS_PER_WORD, 2);
    assert.equal(QUERY_STEMS_MAX, 12);
    // Three candidate stems, two kept: the shortest reach the stored form.
    // (The index fold turns Turkish ı into i; stems are cut after the fold.)
    assert.deepEqual(planTerms(search, "şablonlarında"), ["şablonlarında", "şablon", "şablonların"].map(foldTerm));
    // Twelve unindexed words with two stems each ask for 24; the query budget keeps 12.
    const words = ["şablonlarında", "faturalarında", "müşterilerinde", "raporlarında", "projelerinde",
      "toplantılarında", "sözleşmelerinde", "ödemelerinde", "siparişlerinde", "teklifl" + "erinde",
      "kullanıcılarında", "hesaplarında"];
    const terms = planTerms(search, words.join(" "));
    assert.equal(terms.length, words.length + QUERY_STEMS_MAX);
    assert.deepEqual(terms.slice(0, words.length), words.map(foldTerm));
    assert.equal(new Set(terms).size, terms.length, "no stem is asked for twice");
  });
});
