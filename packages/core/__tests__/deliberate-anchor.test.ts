/**
 * `matched_recall_when` ist eine Aussage über AUTOR-ABSICHT, nicht über
 * lexikalische Nähe (P0 aus docs/recall-performance-handoff.md).
 *
 * Daran hängen zwei Freigaben: der Cross-Scope-Bypass (`hook-skip.ts`) und die
 * Unterdrückung von `weak_result` (`weak-result.ts`). Vor dem Fix reichte ein
 * Fuzzy- oder Prefix-Treffer, um beide zu öffnen — gemessen an `obsidan` und
 * `tripwir` gegen den echten Vault.
 *
 * Runner: node --import tsx --test packages/core/__tests__/deliberate-anchor.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";

async function vaultWith(entries: { id: string; recall_when: string[]; body?: string }[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-anchor-"));
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

${e.body ?? `body of ${e.id}`}
`,
      "utf8",
    );
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  return { dir, vault, search };
}

test("a fuzzy neighbour does not claim authored intent", async (t) => {
  const { dir, search } = await vaultWith([
    { id: "sand-theme", recall_when: ["sand theme umstellen"] },
    { id: "filler", recall_when: ["etwas ganz anderes"] },
  ]);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Ein Edit entfernt von "sand", steht aber nirgends in einem recall_when.
  const hits = search.recall("sadn", { k: 5 });
  const sand = hits.find((h) => h.id === "sand-theme");
  if (sand) {
    assert.equal(
      sand.matched_recall_when,
      false,
      "a fuzzy hit must not set the deliberate anchor — it is intent, not proximity",
    );
  }
});

test("a prefix hit does not claim authored intent", async (t) => {
  const { dir, search } = await vaultWith([
    { id: "tripwire-memo", recall_when: ["tripwire auswerten"] },
  ]);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hits = search.recall("tripwir", { k: 5 });
  const hit = hits.find((h) => h.id === "tripwire-memo");
  assert.ok(hit, "precondition: the prefix must still RETRIEVE the memory");
  assert.equal(
    hit.matched_recall_when,
    false,
    "a prefix hit retrieves, but it does not declare intent",
  );
});

test("the exact authored word still sets the anchor", async (t) => {
  const { dir, search } = await vaultWith([
    { id: "tripwire-memo", recall_when: ["tripwire auswerten"] },
  ]);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("tripwire", { k: 5 }).find((h) => h.id === "tripwire-memo");
  assert.ok(hit, "precondition: the exact term must retrieve the memory");
  assert.equal(hit.matched_recall_when, true, "an exact authored term IS the anchor");
});

test("case does not decide intent", async (t) => {
  const { dir, search } = await vaultWith([
    { id: "memo", recall_when: ["Tripwire auswerten"] },
  ]);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Index und Query werden beide gefaltet; ein großgeschriebener Query-Term
  // muss seinen eigenen Dokumentterm finden, sonst wäre der Anker von der
  // Schreibweise abhängig statt von der Absicht.
  const hit = search.recall("TRIPWIRE", { k: 5 }).find((h) => h.id === "memo");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.matched_recall_when, true, "the anchor must survive case folding");
});

test("a term matching only the body is not an anchor", async (t) => {
  const { dir, search } = await vaultWith([
    { id: "memo", recall_when: ["ganz anderer trigger"], body: "hier steht kanarienvogel im body" },
  ]);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("kanarienvogel", { k: 5 }).find((h) => h.id === "memo");
  assert.ok(hit, "precondition: the body term must retrieve the memory");
  assert.equal(hit.matched_recall_when, false, "the body is not a declared trigger");
});

/**
 * P0 Punkt 6: Der Cross-Scope-Bypass darf nicht an einem einzelnen
 * Allerweltswort hängen. `anchor_strength` trennt „ein häufiges Wort stand
 * zufällig in einer fremden Triggerphrase" von echter Absicht.
 */
test("one common trigger term is a weak anchor", async (t) => {
  // "arbeit" steht in vielen Triggern — hohe document frequency, also für sich
  // kein Beleg, dass dieses Memory gemeint war.
  const entries = Array.from({ length: 60 }, (_, i) => ({
    id: `memo-${i}`,
    recall_when: [`arbeit an sache ${i}`],
  }));
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("arbeit", { k: 5 })[0];
  assert.ok(hit, "precondition: the common term must retrieve something");
  assert.equal(hit.matched_recall_when, true, "it IS an exact trigger match");
  assert.equal(hit.anchor_strength, "weak", "but one common word does not carry intent");
});

test("a rare trigger term carries intent on its own", async (t) => {
  // #360: vorher stand hier "nshostingcontroller" komplett klein — bestand
  // die alte Heuristik nur über die reine Länge (>=12 Zeichen), nicht über
  // eine Bezeichner-Form. Diese Längenschwelle ist raus (siehe
  // looksLikeIdentifier), weil lange deutsche Wörter genauso lang sind. Die
  // authored Phrase steht in echtem camelCase, wie der User es tatsächlich
  // schreiben würde — das ist jetzt das tragende Signal.
  const entries = [
    { id: "rare-memo", recall_when: ["NSHostingController sizingOptions setzen"] },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `noise-${i}`, recall_when: [`arbeit ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("NSHostingController", { k: 5 }).find((h) => h.id === "rare-memo");
  assert.ok(hit, "precondition: the rare identifier must retrieve the memory");
  assert.equal(hit.anchor_strength, "strong", "a rare camelCase identifier speaks for itself");
});

test("two exact trigger terms carry intent even when each is common", async (t) => {
  const entries = [
    { id: "target", recall_when: ["arbeit an datei"] },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a-${i}`, recall_when: [`arbeit ${i}`] })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, recall_when: [`datei ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("arbeit datei", { k: 5 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.anchor_strength, "strong", "two authored terms together are the declaration");
});

test("no trigger match leaves the strength unset", async (t) => {
  const { dir, search } = await vaultWith([
    { id: "memo", recall_when: ["ganz anderer trigger"], body: "kanarienvogel" },
  ]);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("kanarienvogel", { k: 5 }).find((h) => h.id === "memo");
  assert.ok(hit);
  assert.equal(hit.anchor_strength, undefined, "absent, not 'weak' — nothing anchored at all");
});

test("two terms from DIFFERENT authored phrases are not a declaration", async (t) => {
  // Ein Memory mit vielen Triggern sammelt sonst zwei zufällige Wörter aus zwei
  // unabhängigen Situationen ein — das ist Statistik, keine Absicht.
  const entries = [
    { id: "many-triggers", recall_when: ["arbeit an sache", "datei umbenennen"] },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a-${i}`, recall_when: [`arbeit ${i}`] })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, recall_when: [`datei ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("arbeit datei", { k: 5 }).find((h) => h.id === "many-triggers");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.matched_recall_when, true, "both terms ARE authored triggers");
  assert.equal(
    hit.anchor_strength,
    "weak",
    "but they come from two separate situations — that is not one declared context",
  );
});

test("a rare ordinary word alone is not enough — it must look like an identifier", async (t) => {
  // Genau ein Memory trägt das Wort, DF also minimal. Trotzdem ist "quitte"
  // ein gewöhnliches Wort, das jemand beiläufig schreibt.
  const entries = [
    { id: "rare-word", recall_when: ["quitte ernten"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("quitte", { k: 5 }).find((h) => h.id === "rare-word");
  assert.ok(hit, "precondition: the rare word must retrieve the memory");
  assert.equal(hit.anchor_strength, "weak", "rare alone does not carry a cross-scope bypass");
});

test("an identifier with separators carries intent even when short-ish", async (t) => {
  const { dir, search } = await vaultWith([
    { id: "cfg-memo", recall_when: ["bm25_query_max_chars setzen"] },
  ]);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("bm25_query_max_chars", { k: 5 }).find((h) => h.id === "cfg-memo");
  assert.ok(hit, "precondition: the identifier must retrieve the memory");
  assert.equal(hit.anchor_strength, "strong", "separators and digits mark a name, not a word");
});

/**
 * #360 Fehler 1: die Zweierregel zählte EMISSIONEN aus dem flachen
 * Roh-Token-Strom, nicht distinkte authored Wörter. Ein Wort, das zweimal in
 * derselben Phrase steht, ist keine zweite Absichtserklärung — es ist
 * dasselbe Wort zweimal aufgeschrieben.
 */
test("the same word repeated in a phrase does not satisfy the two-term rule", async (t) => {
  const entries = [
    { id: "target", recall_when: ["foo bei foo"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("foo", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(
    hit.anchor_strength,
    "weak",
    "'foo' appears twice, but it is ONE distinct authored word, not two",
  );
});

/**
 * #360 Fehler 1, zweiter Teil: der Dual-Emission-Tokenizer (#162) emittiert
 * `my-app` als `my-app`, `my`, `app`. Ein einzelnes authored Wort darf die
 * Zweierregel nicht allein erfüllen, egal wie viele Terme daraus entstehen.
 */
test("a single hyphenated identifier does not satisfy the two-term rule by itself", async (t) => {
  const entries = [
    { id: "target", recall_when: ["my-app deployen"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // "my" und "app" matchen beide über die Dual-Emission von "my-app" — ohne
  // Fix zwei Treffer aus EINEM Wort.
  const hit = search.recall("my app", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(
    hit.anchor_strength,
    "weak",
    "'my' and 'app' both come from the single word 'my-app' — one origin, not two",
  );
});

/**
 * #360 Fehler 2: "signifikant" war nicht umgesetzt — zwei x-beliebige
 * Allerweltswörter derselben Phrase reichten für "strong".
 */
test("two common filler words from the same phrase are not a declaration", async (t) => {
  const entries = [
    // "aber" und "auch" stehen in der geteilten Stoppwortliste (stopwords.ts)
    // — Funktionswörter ohne eigenes Trigger-Signal.
    { id: "target", recall_when: ["aber auch heute"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("aber auch", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.matched_recall_when, true, "both words ARE authored triggers");
  assert.equal(
    hit.anchor_strength,
    "weak",
    "two filler words do not declare intent, even matched exactly",
  );
});

/**
 * #360 Fehler 3: `DocFreqMiniSearch.docFreq()` summiert über alle sieben
 * indizierten Felder — ein Term, der nur in EINEM authored Trigger, aber in
 * zehn Bodies auftaucht, riss die alte Schwelle künstlich. Gefragt ist die
 * DF innerhalb von `recall_when` allein.
 */
test("rarity is measured over recall_when occurrences, not all fields summed", async (t) => {
  const entries = [
    { id: "target", recall_when: ["widget-9000 konfigurieren"] },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `noise-${i}`,
      recall_when: [`sonstwort ${i}`],
      body: "hier taucht widget-9000 im body auf, nicht im trigger",
    })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("widget-9000", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the identifier must retrieve the memory");
  assert.equal(
    hit.anchor_strength,
    "strong",
    "recall_when-DF is 1 (only 'target' authored it) even though ten bodies also mention it — " +
      "the all-field sum would have wrongly counted 11 and failed the rarity check",
  );
});

/**
 * Die recall_when-DF ist eine von Hand gepflegte Zähl-Map. Solche Maps driften
 * still: Ein vergessenes Aufräumen bei `change` lässt Terme für immer als
 * häufiger gelten, ein doppeltes Abziehen als seltener — und beides ändert
 * lautlos, welches fremde Memory sich in eine Session drängen darf. Deshalb
 * hier der vollständige Lebenszyklus statt nur des Normalfalls.
 */
test("the recall_when frequency map survives change and remove", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-dfmap-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const write = async (id: string, trigger: string): Promise<void> => {
    await writeFile(
      path.join(dir, `${id}.md`),
      `---
id: ${id}
title: ${id}
type: lesson
summary: s
topic_path: [t]
tags: [t]
scope: t
recall_when: [${JSON.stringify(trigger)}]
created: 2020-01-01
updated: 2026-07-01
---

body
`,
      "utf8",
    );
  };

  await write("a", "widgetKonfig anlegen");
  await write("b", "widgetKonfig pruefen");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(() => search.stop());

  // Der private Zähler ist die Sache, die driften kann — hier direkt gelesen,
  // weil ein Test gegen das Endverhalten den Fehler erst Wochen später zeigt.
  const df = (term: string): number =>
    (search as unknown as { recallWhenDocFreq(t: string): number }).recallWhenDocFreq(term);

  assert.equal(df("widgetkonfig"), 2, "zwei Memories tragen den Term");

  // CHANGE: b verliert den Term. Ohne Aufräumen bliebe der Zähler auf 2.
  await write("b", "voellig anderer trigger");
  await vault.reindexFile(path.join(dir, "b.md"));
  assert.equal(df("widgetkonfig"), 1, "nach dem Umschreiben trägt ihn nur noch eines");

  // CHANGE zurück: der Zähler muss wieder steigen, nicht bei 1 kleben.
  await write("b", "widgetKonfig pruefen");
  await vault.reindexFile(path.join(dir, "b.md"));
  assert.equal(df("widgetkonfig"), 2, "und wieder hoch, wenn der Term zurückkommt");

  // REMOVE: der Eintrag muss ganz verschwinden, nicht auf 0 stehen bleiben und
  // auch nicht negativ werden.
  vault.forgetFile(path.join(dir, "a.md"));
  vault.forgetFile(path.join(dir, "b.md"));
  assert.equal(df("widgetkonfig"), 0, "nach dem Entfernen beider trägt ihn keines");

  // Doppeltes Entfernen darf nicht unter null laufen.
  vault.forgetFile(path.join(dir, "a.md"));
  assert.equal(df("widgetkonfig"), 0, "ein zweites Entfernen bleibt folgenlos");
});

/**
 * #360 Nachschlag: die Zweierregel deduplizierte die Phrasenwörter VOR der
 * Normalisierung — über den rohen Text, nicht über die Emissionssignatur.
 * "foo," und "foo" sind als roher Text verschieden, tokenisieren aber beide
 * zu "foo" — ein einziger Begriff erfüllte so die Zweierregel. Jeder Test
 * hier nutzt eine Query mit genau EINEM Begriff: schlägt die Dedup fehl,
 * zählt die Phrase als zwei Ursprünge und wird fälschlich "strong".
 */
test("a comma-separated repetition of the same word is one origin, not two", async (t) => {
  const entries = [
    { id: "target", recall_when: ["foo, foo"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("foo", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.anchor_strength, "weak", "'foo,' and 'foo' tokenize to the same term");
});

test("capitalization alone does not create a second origin", async (t) => {
  const entries = [
    { id: "target", recall_when: ["Foo foo"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("foo", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.anchor_strength, "weak", "'Foo' and 'foo' fold to the same term");
});

test("trailing punctuation on both repetitions does not create two origins", async (t) => {
  const entries = [
    { id: "target", recall_when: ["foo. foo!"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("foo", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.anchor_strength, "weak", "'foo.' and 'foo!' both strip to 'foo'");
});

test("a repeated hyphenated identifier is still one origin, even across punctuation variants", async (t) => {
  // "my-app" ist selbst identifierartig (Bindestrich) — bei niedriger DF
  // greift schon die EINZELTERM-Regel (seltener Bezeichner trägt für sich)
  // und liefert legitim "strong", unabhängig von der Zweierregel. Um die
  // Dedup-Regel isoliert zu prüfen, muss `recall_when`-DF über die
  // Seltenheitsschwelle (5) gedrückt werden (sechs weitere Memories mit
  // demselben Term) — nur dann entscheidet allein die Zweierregel.
  //
  // Die zwei Vorkommen im Ziel-Trigger tragen unterschiedliche
  // Interpunktion ("my-app," / "my-app!") — als ROHER Wort-Text also
  // verschieden, tokenisieren aber beide zu derselben Emissionssignatur.
  const entries = [
    { id: "target", recall_when: ["my-app, my-app!"] },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `common-${i}`,
      recall_when: [`my-app baseline ${i}`],
    })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("my-app", { k: 40 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(
    hit.anchor_strength,
    "weak",
    "'my-app,' and 'my-app!' fold to the same identifier — one origin, not two",
  );
});

test("two genuinely different significant words still declare strong intent", async (t) => {
  // Gegenprobe: die Dedup-Regel darf zwei ECHT verschiedene signifikante
  // Wörter nicht zusammenlegen — die Signatur muss trennscharf bleiben.
  const entries = [
    { id: "target", recall_when: ["arbeit datei"] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("arbeit datei", { k: 20 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(hit.anchor_strength, "strong", "two distinct significant words remain two origins");
});

/**
 * #360 Nachschlag 2: zwei verschiedene WORTURSPRÜNGE reichen nicht — sie
 * müssen auf zwei verschiedene QUERY-TERME abbilden. `my-app` und `your-app`
 * sind zwei Ursprünge, treffen über die Dual-Emission aber beide
 * AUSSCHLIESSLICH denselben Term `app` — die Query enthält nur EIN Wort.
 */
test("two origins that both only match the same single query term stay weak", async (t) => {
  const entries = [
    { id: "target", recall_when: ["my-app your-app"] },
    // Sechs weitere Memories mit "app" im recall_when — drückt die DF von
    // "app" über die Seltenheitsschwelle, damit die EINZELTERM-Regel nicht
    // ohnehin greift und ausschließlich die Zweierregel entscheidet.
    ...Array.from({ length: 6 }, (_, i) => ({ id: `common-${i}`, recall_when: [`app baseline ${i}`] })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("app", { k: 40 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(
    hit.anchor_strength,
    "weak",
    "'my-app' and 'your-app' are two origins, but both hit only the single query term 'app'",
  );
});

test("two origins with two different matched terms declare strong intent", async (t) => {
  const entries = [
    { id: "target", recall_when: ["my-app konfig-datei"] },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("app konfig", { k: 40 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(
    hit.anchor_strength,
    "strong",
    "'my-app' hits 'app', 'konfig-datei' hits 'konfig' — two origins, two distinct terms",
  );
});

/**
 * Team-Lead-Gegenbeispiel: Ursprung A trifft NUR `{app}`, Ursprung B trifft
 * `{app, konfig}` — die Mengen sind verschieden, aber das genügt nicht als
 * Kriterium (siehe Kommentar in `anchorStrength`). Die tatsächliche Frage ist,
 * ob ein Matching auf zwei DISTINKTE Terme existiert: A→app, B→konfig — ja.
 */
test("an origin covering two terms can still pair with a single-term origin", async (t) => {
  const entries = [
    // "app_konfig" emittiert (Dual-Emission über den Unterstrich) sowohl
    // "app" als auch "konfig" aus EINEM Wort — Ursprung B trifft also beide
    // Query-Terme, Ursprung A ("my-app") nur "app".
    { id: "target", recall_when: ["my-app app_konfig verwalten"] },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `n-${i}`, recall_when: [`sonstwort ${i}`] })),
  ];
  const { dir, search } = await vaultWith(entries);
  t.after(async () => {
    search.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const hit = search.recall("app konfig", { k: 40 }).find((h) => h.id === "target");
  assert.ok(hit, "precondition: the memory must be retrieved");
  assert.equal(
    hit.anchor_strength,
    "strong",
    "A hits {app}, B hits {app, konfig} — a matching (A→app, B→konfig) exists",
  );
});
