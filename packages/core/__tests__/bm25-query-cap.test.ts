/**
 * BM25-Query-Cap (#362).
 *
 * Der lexikalische Arm skaliert linear in der Zahl der Query-Terme, und die
 * Hook-Lanes schicken den ganzen Prompt: gemessen 14,8 ms unter 200 Zeichen
 * gegen 741–945 ms über 6000, während der Dense-Arm über alle Bänder konstant
 * bei 104–153 ms liegt. Der Cap ist deshalb ein Kosten-Knob am lexikalischen
 * Arm — und die eigentliche Frage ist nicht, OB gekappt wird, sondern WAS
 * überlebt.
 *
 * Was diese Tests festnageln:
 *   1. unter dem Budget passiert nichts — byte-identische Query, kein
 *      DF-Lookup, also garantiert unverändertes Verhalten für die 90 % der
 *      Calls, die heute schon im Budget liegen
 *   2. über dem Budget überleben die SELTENEN Wörter, nicht die ersten:
 *      derselbe Top-Treffer wie ungekappt, während Präfix-Trunkierung auf
 *      demselben Vault daneben liegt
 *   3. Wörter ohne jeden Index-Term verdrängen keinen echten Treffer-Term,
 *      füllen aber den Rest des Budgets (Fuzzy-Toleranz bleibt)
 *   4. Ausgabe ist immer eine Teilmenge ganzer Wörter — ein halbierter
 *      Identifier matcht nichts und vergiftet prefix/fuzzy
 *   5. ohne DF-Quelle bleibt Präfix als Fallback — der Cap greift trotzdem
 *
 * Runner: node --import tsx --test packages/core/__tests__/bm25-query-cap.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  capBm25Query,
  BM25_QUERY_MAX_CHARS,
  BM25_QUERY_MAX_TERMS,
} from "../src/bm25-query-cap.js";
import { capAtWordBoundary, tokenizeWithIdentifiers } from "../src/query-normalize.js";
import { DocFreqMiniSearch } from "../src/doc-freq-index.js";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";

/** DF aus einer Tabelle; alles Unbekannte ist 0 (= nicht im Index). */
function dfFrom(table: Record<string, number>): (term: string) => number {
  return (term) => table[term.toLowerCase()] ?? 0;
}

/** Wie viele Terme emittiert MiniSearchs Tokenizer für diese Query? */
function termCount(query: string): number {
  return tokenizeWithIdentifiers(query).length;
}

// ─── unter dem Budget: nichts passiert ──────────────────────────────────────

test("#362: a query inside the budget is returned byte-identical, without touching the index", () => {
  const q = "NSHostingController.sizingOptions window grows with SwiftUI content";
  let dfCalls = 0;
  const out = capBm25Query(q, () => {
    dfCalls++;
    return 1;
  });
  assert.equal(out, q, "short queries must pass through unchanged");
  assert.equal(dfCalls, 0, "no DF lookup below the budget — the fast path is a length compare");
});

test("#362: the cap is idempotent — capping a capped query changes nothing", () => {
  const rare = "abandonAfter";
  const q = `${"filler ".repeat(60)}${rare} ${"noise ".repeat(60)}`.trim();
  const df = dfFrom({ filler: 900, noise: 850, abandonafter: 1 });
  const once = capBm25Query(q, df);
  assert.equal(capBm25Query(once, df), once);
});

// ─── über dem Budget: Seltenheit gewinnt ────────────────────────────────────

test("#362: over the budget the RAREST words survive, not the first ones", () => {
  // Ein realistisch geformter Prompt: Rahmen und Höflichkeiten vorn, das
  // diskriminierende Wort in der Mitte.
  const q = [
    "hallo kurz eine frage zu dem thema von gestern bitte einmal anschauen und",
    "dann sagen was du davon haeltst also grundsaetzlich geht es um die stelle",
    "im code die wir gestern besprochen haben und zwar genau um",
    "NSHostingController.sizingOptions",
    "das ist die stelle an der das fenster mitwaechst und danach noch der rest",
    "vom text der nichts weiter beitraegt aber die query lang macht",
  ].join(" ");
  assert.ok(q.length > BM25_QUERY_MAX_CHARS, "fixture must exceed the budget");

  const df = dfFrom({
    // alles Füllmaterial ist häufig …
    ...Object.fromEntries(
      q
        .split(/\s+/)
        .map((w) => [w.toLowerCase(), 700])
        .filter(([w]) => !String(w).startsWith("nshosting")),
    ),
    // … der Identifier und seine Teile sind selten
    "nshostingcontroller.sizingoptions": 1,
    nshostingcontroller: 2,
    sizingoptions: 2,
  });

  const out = capBm25Query(q, df);
  assert.ok(out.length <= BM25_QUERY_MAX_CHARS, `over budget: ${out.length} chars`);
  assert.ok(termCount(out) <= BM25_QUERY_MAX_TERMS, `over budget: ${termCount(out)} terms`);
  assert.ok(
    out.includes("NSHostingController.sizingOptions"),
    `the discriminating identifier must survive — got: ${out}`,
  );
  assert.ok(
    !capAtWordBoundary(q, BM25_QUERY_MAX_CHARS).includes("NSHostingController"),
    "control: prefix truncation would have dropped it — that is what this cap exists for",
  );
});

test("#362: rarity ordering is strict — the two rarest words win a tiny budget", () => {
  const q = "the quick brown fox jumps over the very lazy dog near abandonAfter and fuseRRF";
  const df = dfFrom({
    the: 900, quick: 400, brown: 500, fox: 300, jumps: 600, over: 800,
    very: 850, lazy: 450, dog: 350, near: 700, and: 950,
    abandonafter: 1, fuserrf: 2,
  });
  const out = capBm25Query(q, df, { maxChars: 20, maxTerms: 2 });
  assert.equal(out, "abandonAfter fuseRRF", "rarest two, in original order");

  // Bleibt Budget übrig, kommt der nächstseltenste mit — „fox" (DF 300) vor
  // „the" (DF 900), nicht das erste Wort der Query.
  const roomier = capBm25Query(q, df, { maxChars: 26, maxTerms: 4 });
  assert.equal(roomier, "fox abandonAfter fuseRRF");
});

test("#362: words with no index term at all fill the leftover budget — they never displace a real term", () => {
  // `zzunknownword` ist im Index nicht vorhanden: naive IDF hielte es für
  // maximal selten, dabei trägt es kein BM25-Gewicht und ist pro Term das
  // teuerste, was man kaufen kann (nur noch prefix/fuzzy-Expansion).
  const q = "zzunknownword common frequent abandonAfter";
  const df = dfFrom({ common: 900, frequent: 800, abandonafter: 1 });

  const tight = capBm25Query(q, df, { maxChars: 14, maxTerms: 2 });
  assert.equal(tight, "abandonAfter", "the indexed rare term outranks the unknown one");

  const roomy = capBm25Query(q, df, { maxChars: 50, maxTerms: 8 });
  assert.ok(roomy.includes("abandonAfter"));
  assert.ok(roomy.includes("zzunknownword"), "with budget left over it still comes along");
  assert.ok(
    roomy.indexOf("zzunknownword") < roomy.indexOf("abandonAfter"),
    "output keeps the original word order regardless of selection order",
  );
});

test("#362: repeated words are selected once — a second trie walk buys no ranking", () => {
  const q = `${"abandonAfter ".repeat(20)}${"common ".repeat(20)}`.trim();
  const df = dfFrom({ abandonafter: 1, common: 900 });
  const out = capBm25Query(q, df);
  assert.equal(out.split(/\s+/).filter((w) => w === "abandonAfter").length, 1);
  assert.ok(out.length <= BM25_QUERY_MAX_CHARS);
});

test("#362: the output is always whole words from the input — never a split token", () => {
  const q = [
    "packages/core/src/search.ts:441",
    "my-app.config.ts",
    "--force-push",
    ...Array.from({ length: 40 }, (_, i) => `filler${i % 3}`),
  ].join(" ");
  const df = dfFrom({ "my-app.config.ts": 1, "--force-push": 2, filler0: 900, filler1: 900, filler2: 900 });
  const out = capBm25Query(q, df, { maxChars: 60, maxTerms: 12 });
  const inputWords = new Set(q.split(/\s+/));
  for (const w of out.split(/\s+/)) {
    assert.ok(inputWords.has(w), `"${w}" is not a whole word from the query`);
  }
});

test("#362: punctuation-only words carry no term and are dropped", () => {
  // „—" und „…" fallen in MiniSearchs Splitter-Klasse (\p{P}) und emittieren
  // keinen Term. „|" wäre ein Symbol (\p{Sm}), kein Punctuation — das ist ein
  // Token und darf hier deshalb nicht mitgeprüft werden.
  const q = `— … ${"filler ".repeat(50)}abandonAfter`;
  const out = capBm25Query(q, dfFrom({ filler: 900, abandonafter: 1 }));
  assert.ok(!out.includes("—"), `dash survived: ${out}`);
  assert.ok(!out.includes("…"), `ellipsis survived: ${out}`);
  assert.ok(out.includes("abandonAfter"));
});

// ─── Fallback ───────────────────────────────────────────────────────────────

test("#362: without a DF source the cap falls back to prefix — cheaper, never worse in cost", () => {
  const q = `${"word ".repeat(200)}rareterm`;
  const out = capBm25Query(q);
  assert.equal(out, capAtWordBoundary(q, BM25_QUERY_MAX_CHARS));
  assert.ok(out.length <= BM25_QUERY_MAX_CHARS);
});

test("#362: a monster token with no whitespace still gets capped", () => {
  const q = "x".repeat(5000);
  const out = capBm25Query(q, dfFrom({}));
  assert.ok(out.length <= BM25_QUERY_MAX_CHARS, `got ${out.length} chars`);
});

// ─── DF-Zugriff ─────────────────────────────────────────────────────────────

test("#362: DocFreqMiniSearch reads document frequency out of the index that already exists", () => {
  const mini = new DocFreqMiniSearch<{ id: string; title: string; body: string }>({
    fields: ["title", "body"],
    storeFields: ["id"],
  });
  mini.add({ id: "1", title: "alpha", body: "common common" });
  mini.add({ id: "2", title: "beta", body: "common" });
  mini.add({ id: "3", title: "gamma", body: "common" });

  assert.equal(mini.docFreq("common"), 3, "in the body of all three");
  assert.equal(mini.docFreq("alpha"), 1);
  assert.equal(mini.docFreq("ALPHA"), 1, "case-folded like the index itself");
  assert.equal(mini.docFreq("nosuchterm"), 0, "0 means: not in the index");
  assert.ok(
    mini.docFreq("common") > mini.docFreq("alpha"),
    "the ordering is the only thing the cap needs from this number",
  );
});

// ─── Integration: gleiche Top-Treffer auf einem echten Index ────────────────

function memoryMd(id: string, body: string, extraTitle = ""): string {
  return `---
id: ${id}
title: ${id} ${extraTitle}
type: lesson
summary: ${id} summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["${id}"]
created: 2020-01-01
updated: 2026-07-01
---

${body}
`;
}

test("#362: on a real index the capped query returns the same top hit as the uncapped one — prefix truncation does not", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-bm25cap-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // 12 Memories, die alle dasselbe Füllvokabular tragen (hohe DF) — eines
  // trägt zusätzlich den seltenen Identifier.
  const filler = "hallo kurz eine frage zu dem thema von gestern bitte anschauen sagen davon haeltst grundsaetzlich stelle code besprochen genau danach rest text nichts beitraegt";
  for (let i = 0; i < 11; i++) {
    await writeFile(path.join(dir, `n${i}.md`), memoryMd(`note-${i}`, filler), "utf8");
  }
  await writeFile(
    path.join(dir, "rare.md"),
    memoryMd("note-rare", `${filler} NSHostingController.sizingOptions`, "sizingOptions"),
    "utf8",
  );

  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(() => search.stop());

  // Langer Prompt: Füllmaterial vorn, das diskriminierende Wort in der Mitte.
  const longQuery = `${filler} ${filler} NSHostingController.sizingOptions ${filler}`;
  assert.ok(longQuery.length > BM25_QUERY_MAX_CHARS * 2, "fixture must be well over the budget");

  // `bm25_query_max_chars: 0` ist der Kill-Switch — Verhalten vor #362.
  const uncapped = search.recall(longQuery, { k: 5, bm25_query_max_chars: 0 });
  assert.equal(uncapped[0]?.id, "note-rare", "precondition: uncapped finds the rare memory first");

  const capped = search.recall(longQuery, { k: 5 });
  assert.equal(capped[0]?.id, "note-rare", "the capped lexical arm keeps the same top hit");
  assert.deepEqual(
    capped.map((h) => h.id),
    uncapped.map((h) => h.id),
    "same top-k, same order — the cap dropped cost, not signal",
  );

  // Kontrolle: präfix-getrunkiert verliert der Arm genau diesen Treffer.
  const prefix = capAtWordBoundary(longQuery, BM25_QUERY_MAX_CHARS);
  assert.ok(!prefix.includes("NSHostingController"), "the identifier sits past the prefix cut");
  const prefixHits = search.recall(prefix, { k: 5 });
  assert.notEqual(
    prefixHits[0]?.id,
    "note-rare",
    "prefix truncation would have lost the discriminating hit — the reason for rarity selection",
  );
});
