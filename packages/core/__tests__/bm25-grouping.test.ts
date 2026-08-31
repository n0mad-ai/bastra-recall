/**
 * Die Termgruppierung ist der einzige Performance-Hebel in #362, der ohne
 * Qualitätspreis auskommt — aber nur, solange sie WIRKLICH rangneutral ist.
 * Zwei Dinge kippen sie still, und beide sind hier festgenagelt:
 *
 * 1. Zählen vor statt nach `processTerm`: `Recall` und `recall` werden zwei
 *    Einträge, die Häufigkeiten verteilen sich falsch. Gemessen 0/30 statt
 *    30/30 identische Ranglisten.
 * 2. Der Identifier-Tokenizer läuft zweimal: Die gruppierte Query ist ein
 *    String, und ohne Identitäts-Tokenizer zerlegt MiniSearch `foo.bar.ts`
 *    erneut in seine Teile.
 *
 * Runner: node --import tsx --test packages/core/__tests__/bm25-grouping.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import MiniSearch from "minisearch";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { groupQueryTerms, groupedTokenize } from "../src/bm25-grouping.js";
import { tokenizeWithIdentifiers } from "../src/query-normalize.js";

test("counting happens after folding, not before", () => {
  const g = groupQueryTerms("Recall recall RECALL", tokenizeWithIdentifiers);
  assert.equal(g.counts.get("recall"), 3, "one term seen three times, not three terms");
  assert.equal(g.counts.size, 1);
  assert.equal(g.emitted, 3, "the emitted count keeps the original volume for telemetry");
});

test("the identity tokenizer does not re-split what is already a term list", () => {
  // Dual emission (#162): der Identifier steht als Ganzes UND zerlegt in der
  // Liste. Ein zweiter Tokenizer-Lauf würde den Ganzen erneut zerlegen und die
  // Teile doppelt zählen.
  const g = groupQueryTerms("my-app.config.ts", tokenizeWithIdentifiers);
  const roundTrip = groupedTokenize(g.query);
  assert.deepEqual(
    [...roundTrip].sort(),
    [...g.counts.keys()].sort(),
    "the grouped query must round-trip through the identity tokenizer unchanged",
  );
});

test("empty query yields no terms rather than one empty term", () => {
  assert.deepEqual(groupedTokenize(""), []);
  const g = groupQueryTerms("", tokenizeWithIdentifiers);
  assert.equal(g.counts.size, 0);
  assert.equal(g.query, "");
});

/**
 * Der eigentliche Beweis: Gruppiert und ungruppiert müssen über einen echten
 * Index dieselbe Rangliste liefern — inklusive der Reihenfolge, nicht nur der
 * Menge. Ein Vault mit überlappenden Termen und wiederholten Query-Wörtern ist
 * genau die Konstellation, in der eine falsch verteilte Häufigkeit auffällt.
 */
test("grouped and ungrouped produce the identical ranking over a real index", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-grouping-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  for (let i = 0; i < 30; i++) {
    const body = words.slice(i % 3, (i % 3) + 4).join(" ").repeat(1 + (i % 4));
    await writeFile(
      path.join(dir, `m${i}.md`),
      `---
id: m${i}
title: ${words[i % words.length]} memo ${i}
type: lesson
summary: ${words[(i + 1) % words.length]} summary ${i}
topic_path: [t]
tags: [${words[(i + 2) % words.length]}]
scope: t
recall_when: ["${words[(i + 3) % words.length]} situation ${i}"]
created: 2020-01-01
updated: 2026-07-01
---

${body}
`,
      "utf8",
    );
  }

  const vault = new Vault(dir);
  await vault.init();

  // Index mit den Produktionsoptionen — der ungruppierte Vergleichsarm.
  const BOOST = {
    recall_when_flat: 5,
    title: 4,
    tags_flat: 3,
    recall_when_expanded_flat: 2,
    topic_path_flat: 2,
    summary: 2,
    body: 1,
  };
  const mini = new MiniSearch({
    fields: Object.keys(BOOST),
    storeFields: ["id"],
    tokenize: tokenizeWithIdentifiers,
    searchOptions: { boost: BOOST, fuzzy: 0.2, prefix: true, combineWith: "OR" },
  });
  mini.addAll(
    vault.list().map((m) => ({
      id: m.fm.id,
      title: m.fm.title,
      summary: m.fm.summary,
      tags_flat: m.fm.tags.join(" "),
      recall_when_flat: m.fm.recall_when.join(" \n "),
      recall_when_expanded_flat: "",
      topic_path_flat: m.fm.topic_path.join(" "),
      body: m.body,
    })),
  );

  const queries = [
    "Alpha alpha beta ALPHA gamma alpha",
    "delta delta epsilon zeta delta memo memo",
    "alpha beta gamma delta epsilon zeta alpha beta gamma",
  ];

  for (const q of queries) {
    const plain = mini.search(q).map((h) => `${h.id}:${(h.score as number).toFixed(6)}`);
    const g = groupQueryTerms(q, tokenizeWithIdentifiers);
    const grouped = mini
      .search(g.query, {
        tokenize: groupedTokenize,
        boostTerm: (term: string) => g.counts.get(term) ?? 1,
      })
      .map((h) => `${h.id}:${(h.score as number).toFixed(6)}`);

    assert.ok(plain.length > 0, `precondition: "${q}" must retrieve something`);
    assert.deepEqual(grouped, plain, `grouping changed the ranking for "${q}"`);
  }

  await vault.stop();
});

test("the production search path still ranks the repeated term first", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-grouping-prod-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  for (const [id, word] of [
    ["kanarienvogel-memo", "kanarienvogel"],
    ["other-memo", "sonstwort"],
  ]) {
    await writeFile(
      path.join(dir, `${id}.md`),
      `---
id: ${id}
title: ${word} memo
type: lesson
summary: ${word} summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["${word} situation"]
created: 2020-01-01
updated: 2026-07-01
---

${word} body
`,
      "utf8",
    );
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(() => search.stop());

  // Wiederholung muss weiterhin Gewicht haben: Wer ein Wort dreimal nennt,
  // meint es. Ginge `boostTerm` verloren, stünden beide Treffer gleichauf.
  const hits = search.recall("kanarienvogel kanarienvogel kanarienvogel sonstwort", { k: 2 });
  assert.equal(hits[0]?.id, "kanarienvogel-memo", "the thrice-named term must still win");
});

/** #362 Phase 3: der schnelle Pfad — exact + prefix, kein Fuzzy. */
test("bm25_no_fuzzy drops the typo tolerance and keeps the exact hit", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-nofuzzy-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await writeFile(
    path.join(dir, "m.md"),
    `---
id: anchorword-memo
title: anchorword memo
type: lesson
summary: anchorword summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["anchorword situation"]
created: 2020-01-01
updated: 2026-07-01
---

anchorword body
`,
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(() => search.stop());

  // Der Tippfehler lebt allein von der Fuzzy-Expansion.
  assert.ok(
    search.recall("anchorwrd", { k: 3 }).some((h) => h.id === "anchorword-memo"),
    "precondition: with fuzzy the typo finds the memory",
  );
  assert.equal(
    search.recall("anchorwrd", { k: 3, bm25_no_fuzzy: true }).length,
    0,
    "the fast path trades typo recall for latency — that is the whole price",
  );
  // Exakt und Präfix müssen weiter tragen, sonst wäre der Pfad wertlos.
  assert.ok(
    search.recall("anchorword", { k: 3, bm25_no_fuzzy: true }).some((h) => h.id === "anchorword-memo"),
    "the exact term must still hit",
  );
  assert.ok(
    search.recall("anchorwo", { k: 3, bm25_no_fuzzy: true }).some((h) => h.id === "anchorword-memo"),
    "and so must a prefix",
  );
});

/** #362 Phase 2: der Router entscheidet an den Kosten, nicht an der Länge. */
test("routeRetrieval picks the mode from cost and availability", async () => {
  const { routeRetrieval } = await import("../src/retrieval-mode.js");
  const budget = { budgetMs: 200, denseReservedMs: 150 };

  assert.equal(routeRetrieval({ uniqueTerms: 25, denseAvailable: true, ...budget }).mode, "hybrid");
  assert.equal(
    routeRetrieval({ uniqueTerms: 613, denseAvailable: true, ...budget }).mode,
    "dense-primary",
    "an expensive lexical arm hands the long prompt to the dense one",
  );
  assert.equal(
    routeRetrieval({ uniqueTerms: 25, denseAvailable: false, ...budget }).mode,
    "lexical-full",
    "without a dense arm a cheap query still gets the full treatment",
  );
  assert.equal(
    routeRetrieval({ uniqueTerms: 613, denseAvailable: false, ...budget }).mode,
    "lexical-fast",
    "without a dense arm there is nowhere to hand it — the fast path is the only answer",
  );
  // Ohne Budget gibt es nichts zu unterschreiten.
  assert.equal(
    routeRetrieval({ uniqueTerms: 5000, denseAvailable: true, budgetMs: 0, denseReservedMs: 150 }).mode,
    "hybrid",
  );
});

test("the budget uses max(lexical, dense), not their sum", async () => {
  const { routeRetrieval } = await import("../src/retrieval-mode.js");
  const { estimateBm25Ms } = await import("../src/query-cost.js");

  // Die Arme überlappen: Der dichte wird vor BM25 abgesendet und läuft
  // währenddessen. Eine Addition hätte hier `dense-primary` gewählt und dem
  // lexikalischen Arm 150 der 200 ms weggerechnet, die er nie kostet.
  const terms = 150;
  assert.ok(estimateBm25Ms(terms) < 150, "precondition: lexical is the cheaper arm here");
  assert.equal(
    routeRetrieval({ uniqueTerms: terms, denseAvailable: true, budgetMs: 200, denseReservedMs: 150 }).mode,
    "hybrid",
    "a lexical arm cheaper than the dense one costs no extra wall clock at all",
  );

  // Erst wenn der lexikalische Arm den dichten ÜBERHOLT, wird er zum Problem.
  const many = 400;
  assert.ok(estimateBm25Ms(many) > 200, "precondition: now lexical exceeds the budget by itself");
  assert.equal(
    routeRetrieval({ uniqueTerms: many, denseAvailable: true, budgetMs: 200, denseReservedMs: 150 }).mode,
    "dense-primary",
  );
});
