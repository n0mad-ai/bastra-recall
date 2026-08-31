/**
 * Tests für den Query-Tokenizer-LRU-Cache in `SearchIndex` (#30).
 *
 * Verifiziert: identischer Query → Cache-Hit (kein erneutes MiniSearch),
 * unterschiedliche opts → Cache-Miss (Key enthält JSON-stringified opts),
 * Vault-Change → komplettes clear(), LRU-Eviction bei > 100 distinct Keys.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/query-cache.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";
import type { StageListener } from "../src/recall-stages.js";

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function makeVault(memos: { id: string; title: string }[]): Promise<{ vault: Vault; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-query-test-"));
  for (const m of memos) {
    await writeFile(join(dir, `${m.id}.md`), memoryMarkdown(m.id, m.title), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  return { vault, dir };
}

function getQueryCache(idx: SearchIndex): Map<string, { hits: unknown[]; at: number }> {
  return (idx as unknown as {
    queryCache: Map<string, { hits: unknown[]; at: number }>;
  }).queryCache;
}

/** #365/4: `EmbeddingIndex.search()` swallows every provider failure and hands
 *  back `[]` — the same value as "this vault has no vectors". The empty case is
 *  a property of the vault and caches by design; the error case is a property
 *  of this call and must not. */
class FlakyProvider implements EmbeddingProvider {
  readonly id = "flaky-mock";
  readonly dim = 3;
  public failing = false;
  public calls = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.failing) throw new Error("provider down (5xx)");
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

/** Collects the `done` stage meta so `degraded` / `cached` are assertable. */
function doneMeta(): { onStage: StageListener; last: () => Record<string, unknown> } {
  let seen: Record<string, unknown> | null = null;
  return {
    onStage: (e) => {
      if (e.name === "done") seen = e.meta ?? {};
    },
    last: () => {
      assert.ok(seen !== null, "no `done` stage event observed");
      return seen;
    },
  };
}

async function makeHybrid(opts: { failFromStart?: boolean } = {}): Promise<{
  idx: SearchIndex;
  provider: FlakyProvider;
  close: () => Promise<void>;
}> {
  const { vault, dir } = await makeVault([
    { id: "hy-1", title: "alpha bravo" },
    { id: "hy-2", title: "alpha charlie" },
  ]);
  const idx = new SearchIndex(vault);
  idx.start();
  const provider = new FlakyProvider();
  provider.failing = opts.failFromStart === true;
  const emb = new EmbeddingIndex(vault, provider, join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  idx.useEmbeddings(emb);
  return {
    idx,
    provider,
    close: async () => {
      await emb.stop();
      idx.stop();
      await vault.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("query-cache #365/4: ein Provider-Fehler wird nicht gecacht und heißt vector-arm-error", async () => {
  // Vectors exist (the index started healthy), then the provider dies. The
  // cache key varies on embeddings.size(), which does not move for a 5xx — so
  // without the fix the one-armed answer survived the recovery for the full TTL.
  const { idx, provider, close } = await makeHybrid();
  try {
    provider.failing = true;

    const first = doneMeta();
    const degraded = await idx.recallHybrid("alpha", { k: 5, onStage: first.onStage });
    assert.equal(
      first.last().degraded,
      "vector-arm-error",
      "a provider failure must be distinguishable from an empty vector arm",
    );
    assert.ok(degraded.every((h) => h.mode === "bm25"), "degrades through the BM25 path");

    const second = doneMeta();
    await idx.recallHybrid("alpha", { k: 5, onStage: second.onStage });
    assert.notEqual(second.last().cached, true, "the failed call must not have been cached");

    // Provider recovers — the identical query has to reach it again.
    provider.failing = false;
    const callsBefore = provider.calls;
    const recovered = await idx.recallHybrid("alpha", { k: 5 });
    assert.ok(provider.calls > callsBefore, "the recovered query must reach the provider");
    assert.ok(
      recovered.some((h) => h.mode !== "bm25"),
      "and must be served from both arms, not from the cached degradation",
    );
  } finally {
    await close();
  }
});

test("query-cache #365/4: zwei Fehler in derselben Millisekunde bleiben beide sichtbar", async () => {
  // Der Diskriminator darf nicht `lastErrorAt` sein: der hat ms-Auflösung, und
  // der ZWEITE Fehler innerhalb derselben Millisekunde liest den Stempel des
  // ersten als `errBefore` und setzt denselben Wert — `errAfter === errBefore`,
  // false negative, einarmiges Ergebnis gecacht und als `vector-arm-empty`
  // gelabelt. Genau der Defekt, den Item 4 schließt. Eine eingefrorene Uhr
  // macht dieses Rennen deterministisch statt flaky.
  const { idx, provider, close } = await makeHybrid();
  const realNow = Date.now;
  try {
    provider.failing = true;
    const frozen = realNow();
    Date.now = () => frozen;

    const a = doneMeta();
    await idx.recallHybrid("alpha", { k: 5, onStage: a.onStage });
    assert.equal(a.last().degraded, "vector-arm-error", "erster Fehler");

    const b = doneMeta();
    await idx.recallHybrid("alpha", { k: 5, onStage: b.onStage });
    assert.equal(
      b.last().degraded,
      "vector-arm-error",
      "der zweite Fehler in derselben ms darf nicht als leerer Vektor-Arm durchgehen",
    );
    assert.notEqual(b.last().cached, true, "und schon gar nicht aus dem Cache kommen");

    const c = doneMeta();
    await idx.recallHybrid("alpha", { k: 5, onStage: c.onStage });
    assert.notEqual(c.last().cached, true, "keiner der beiden Fehler-Calls wurde gecacht");

    // Und der Fall, den der Zähler ebenfalls trägt: zwei Lanes gleichzeitig.
    const p = [doneMeta(), doneMeta()];
    await Promise.all(p.map((m) => idx.recallHybrid("bravo", { k: 5, onStage: m.onStage })));
    for (const m of p) assert.equal(m.last().degraded, "vector-arm-error");
  } finally {
    Date.now = realNow;
    await close();
  }
});

test("query-cache #365/4: ein Vault ohne Vektoren cached weiterhin (vector-arm-empty)", async () => {
  // Gegenprobe zum Test darüber: no vectors at all, no provider call on the
  // query path, so nothing about this call failed. #342's contract stands.
  const { idx, close } = await makeHybrid({ failFromStart: true });
  try {
    const first = doneMeta();
    await idx.recallHybrid("alpha", { k: 5, onStage: first.onStage });
    assert.equal(first.last().degraded, "vector-arm-empty");

    const second = doneMeta();
    await idx.recallHybrid("alpha", { k: 5, onStage: second.onStage });
    assert.equal(second.last().cached, true, "an empty vector arm is a property of the vault");
  } finally {
    await close();
  }
});

test("query-cache: zweiter Recall mit identischem Query hit Cache", async () => {
  const { vault, dir } = await makeVault([
    { id: "qc-1", title: "alpha bravo" },
    { id: "qc-2", title: "charlie delta" },
  ]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);
    assert.equal(cache.size, 0);

    const a = idx.recall("alpha", { k: 5 });
    assert.equal(cache.size, 1, "Cache füllt sich nach Recall");
    const a2 = idx.recall("alpha", { k: 5 });
    assert.equal(cache.size, 1, "zweiter Call ändert Cache-Größe nicht");
    assert.deepEqual(
      a.map((h) => h.id),
      a2.map((h) => h.id),
      "gleiche IDs aus dem Cache",
    );

    await idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("query-cache: andere opts → Cache-Miss (separater Key)", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);
    idx.recall("alpha", { k: 5 });
    assert.equal(cache.size, 1);

    // Anderer k → anderer Key → zweiter Eintrag im Cache.
    idx.recall("alpha", { k: 3 });
    assert.equal(cache.size, 2, "unterschiedliche opts erzeugen separate Cache-Keys");

    // Scope-Filter → wieder anderer Key.
    idx.recall("alpha", { k: 5, scope: "other-scope" });
    assert.equal(cache.size, 3);

    await idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("query-cache: Vault-Change leert den Cache komplett", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);
    idx.recall("alpha", { k: 5 });
    idx.recall("bravo", { k: 5 });
    assert.equal(cache.size, 2);

    // change event über reindexFile.
    await writeFile(
      join(dir, "qc-1.md"),
      memoryMarkdown("qc-1", "alpha bravo updated"),
      "utf8",
    );
    await vault.reindexFile(join(dir, "qc-1.md"));

    assert.equal(cache.size, 0, "Cache wurde geleert");

    await idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("query-cache: LRU-Eviction bei > 100 Keys", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);

    // 100 verschiedene Queries → Cache läuft voll.
    for (let i = 0; i < 100; i++) {
      idx.recall(`query-${i}`, { k: 5 });
    }
    assert.equal(cache.size, 100, "Cache füllt sich bis zum Limit");

    const firstKey = `recall|query-0|${JSON.stringify({ k: 5 })}`;
    assert.ok(cache.has(firstKey), "erste Query noch im Cache");

    // 101. Query → erste muss rausfliegen.
    idx.recall("query-100", { k: 5 });
    assert.equal(cache.size, 100, "Cache-Größe bleibt am Limit");
    assert.equal(cache.has(firstKey), false, "älteste Query wurde gedroppt");
    assert.ok(cache.has(`recall|query-100|${JSON.stringify({ k: 5 })}`));

    await idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("query-cache: LRU-Bump bei Hit verhindert Eviction der gebumpten Query", async () => {
  const { vault, dir } = await makeVault([{ id: "qc-1", title: "alpha bravo" }]);
  try {
    const idx = new SearchIndex(vault);
    idx.start();

    const cache = getQueryCache(idx);

    // Fülle Cache exakt voll.
    for (let i = 0; i < 100; i++) {
      idx.recall(`q-${i}`, { k: 5 });
    }

    // „query-0" nochmal anfassen → bump auf jüngst.
    idx.recall("q-0", { k: 5 });

    // Eine neue Query → jetzt fliegt „q-1" raus (q-0 war gerade gebumpt).
    idx.recall("q-new", { k: 5 });
    assert.equal(cache.has(`recall|q-0|${JSON.stringify({ k: 5 })}`), true, "gebumpte Query bleibt");
    assert.equal(cache.has(`recall|q-1|${JSON.stringify({ k: 5 })}`), false, "vorher zweitälteste fliegt raus");

    await idx.stop();
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("query-cache P0: ein Cache-Hit auf die einarmige Antwort behält den Score-Modus", async () => {
  // Der Fehlerfall: `vector-arm-empty` wird gecacht (korrekt, siehe #342 —
  // das ist eine Eigenschaft des Vaults), aber der Cache-Eintrag trug den
  // Degradations-Grund nicht mit. Beim zweiten identischen Aufruf meldete
  // `done` nur noch `cached: true` — der Recall-Handler leitet `score_kind`
  // aber genau aus diesem Feld ab. Ergebnis: derselbe rohe BM25-Score
  // (z.B. 1997.338) kam beim ersten Aufruf als `bm25`/`unfused` heraus und
  // beim zweiten als `rrf`. Damit wurden die Bänder 50/100, die nur auf der
  // RRF-Skala (Obergrenze 163.934) definiert sind, auf eine offene Skala
  // angewendet.
  const { idx, close } = await makeHybrid({ failFromStart: true });
  try {
    const first = doneMeta();
    const cold = await idx.recallHybrid("alpha", { k: 5, onStage: first.onStage });
    assert.equal(first.last().degraded, "vector-arm-empty", "Vorbedingung: kalt degradiert");

    const second = doneMeta();
    const warm = await idx.recallHybrid("alpha", { k: 5, onStage: second.onStage });
    assert.equal(second.last().cached, true, "Vorbedingung: der zweite Aufruf kommt aus dem Cache");
    assert.equal(
      second.last().degraded,
      "vector-arm-empty",
      "der Cache-Hit serviert BM25-Scores und muss das auch sagen",
    );
    assert.deepEqual(
      warm.map((h) => h.score),
      cold.map((h) => h.score),
      "identische Zahlen — sie dürfen nur nicht anders benannt werden",
    );
    assert.ok(warm.every((h) => h.mode === "bm25"));
  } finally {
    await close();
  }
});
