/**
 * Tests for #351 — recall batch mode: queries[] runs each phrasing through
 * the full single pipeline and merges by best original score.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/recall-batch.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, RecallArgs, type ToolDeps } from "../src/tool-handlers.js";
import { mergeBatchResults, projectRecallResult } from "../src/recall-batch.js";

function memoryMd(id: string, title: string, trigger: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: personal",
    "recall_when:",
    `  - ${trigger}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `${title} body.`,
    "",
  ].join("\n");
}

test("recallHandler (#351): queries[] merges per-phrasing results, deduped by best score", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-batch-"));
  try {
    await writeFile(join(dir, "a.md"), memoryMd("panel-lesson", "NSPanel resignKey dismissal", "panel closes on resignKey observer"), "utf8");
    await writeFile(join(dir, "b.md"), memoryMd("scroll-lesson", "NSScrollView trailing inset", "scrollview trailing inset macos"), "utf8");
    const vault = new Vault(dir);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    const deps = { vault, search, telemetry: new Telemetry(), vaultPath: dir } as ToolDeps;

    const single = await recallHandler(deps, { query: "panel resignKey observer", min_score: 0 });
    assert.ok(single.hits.length > 0, "single-query path still works");

    const batched = await recallHandler(deps, {
      queries: ["panel resignKey observer", "scrollview trailing inset"],
      min_score: 0,
    });
    const ids = (batched.hits as { id: string }[]).map((h) => h.id);
    assert.ok(ids.includes("panel-lesson"), "first phrasing's hit present");
    assert.ok(ids.includes("scroll-lesson"), "second phrasing's hit present");
    assert.equal(new Set(ids).size, ids.length, "no duplicate ids after merge");
    assert.equal((batched as { query_count?: number }).query_count, 2);
    assert.ok(Array.isArray((batched as { recall_ids?: string[] }).recall_ids), "per-query recall_ids exposed");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("RecallArgs (#351): query XOR queries", () => {
  assert.equal(RecallArgs.safeParse({ queries: ["a phrase", "b phrase"] }).success, true);
  assert.equal(RecallArgs.safeParse({ queries: ["only one"] }).success, false, "min 2 phrasings");
  assert.equal(RecallArgs.safeParse({}).success, true, "schema allows absence — handler enforces presence");
});

test("mergeBatchResults: unfused Phrasierungen fusionieren über die Ränge, weak_result nur wenn ALLE weak sind", () => {
  // Ohne `score_kind` gilt fail-closed der unbegrenzte Raum. Codex-Gegenreview
  // (P0): Rohe BM25-Werte sind auch UNTEREINANDER nicht vergleichbar —
  // Termzahl, Querylänge und Expansion verschieben die absolute Höhe, ohne dass
  // der Treffer besser passt. Zwei unfused Listen werden deshalb über die
  // Ränge zusammengeführt, nicht über die Zahlen.
  const merged = mergeBatchResults(
    ["q1", "q2"],
    [
      { hits: [{ id: "x", score: 50 }], recall_id: "r1", weak_result: true },
      { hits: [{ id: "x", score: 120 }, { id: "y", score: 40 }], recall_id: "r2" },
    ],
    5,
  );
  assert.equal(merged.merged_by, "query-rank-fusion");
  assert.equal(merged.hits[0]!.id, "x", "in beiden Listen vorn — das ist das Rang-Signal");
  // `x` steht in BEIDEN Listen auf Rang 1; bei Gleichstand gewinnt die erste.
  // Ausgewiesen wird deren echter Score — nie eine aus zwei Skalen
  // zusammengerechnete Mischzahl.
  assert.equal(merged.hits[0]!.score, 50);
  assert.equal(merged.score_version, undefined, "auf einer rohen Skala gibt es keine Formelversion");
  assert.equal(merged.weak_result, undefined, "one anchored phrasing clears the batch");
  assert.deepEqual(merged.recall_ids, ["r1", "r2"]);

  const allWeak = mergeBatchResults(["q1", "q2"], [{ hits: [], weak_result: true, no_home: true }, { hits: [], weak_result: true, no_home: true }], 5);
  assert.equal(allWeak.weak_result, true);
  assert.equal(allWeak.no_home, true);
});

test("dedupeQueries (zzalli's report): concept remixes collapse, real paraphrases and sub-questions survive", async () => {
  const { dedupeQueries, queryOverlap, BATCH_DUPLICATE_MIN } = await import("../src/recall-batch.js");

  // The failure mode: the same concepts remixed three times.
  const remix = dedupeQueries([
    "bp-logistics Spedition Fahrzeugtransport Autohaus Projekt",
    "Fahrzeugtransport Spedition bp-logistics Autohaus",
    "Projekt Autohaus bp-logistics Spedition Fahrzeugtransport",
  ]);
  assert.equal(remix.kept.length, 1, "remixes of the same tokens are one intent");
  assert.equal(remix.collapsed.length, 2);
  assert.ok(remix.max_overlap >= BATCH_DUPLICATE_MIN);

  // The design hope: distinct vocabulary per intent — nothing collapses.
  const good = dedupeQueries([
    "Spedition Fahrzeugtransport Auftrag",
    "Website App Anforderungen Spezifikation",
    "Stack-Präferenzen neues Projekt aufsetzen",
  ]);
  assert.equal(good.kept.length, 3, "distinct intents all run");
  assert.equal(good.collapsed.length, 0);

  // Umlaut folding flows through the shared tokenizer.
  assert.ok(queryOverlap("Präferenzen fürs Projekt", "Praeferenzen fuers Projekt") >= BATCH_DUPLICATE_MIN);
});

test("recallHandler (#351 guard): a duplicate query is collapsed, the result says so, telemetry counts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-batch-guard-"));
  try {
    await writeFile(join(dir, "a.md"), memoryMd("panel-lesson", "NSPanel resignKey dismissal", "panel closes on resignKey observer"), "utf8");
    const vault = new Vault(dir);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    const deps = { vault, search, telemetry: new Telemetry(), vaultPath: dir } as ToolDeps;

    const batched = await recallHandler(deps, {
      queries: [
        "panel resignKey observer dismissal",
        "resignKey panel dismissal observer",
        "scrollview trailing inset",
      ],
      min_score: 0,
    });
    const r = batched as {
      query_count?: number;
      queries_collapsed?: number;
      note?: string;
      recall_ids?: string[];
    };
    assert.equal(r.query_count, 3, "query_count reports what the model SENT");
    assert.equal(r.queries_collapsed, 1);
    assert.match(r.note ?? "", /ONE distinct intent/);
    assert.equal(r.recall_ids?.length, 2, "only the distinct queries paid a search");

    const clean = await recallHandler(deps, {
      queries: ["panel resignKey observer", "scrollview trailing inset"],
      min_score: 0,
    });
    assert.equal((clean as { queries_collapsed?: number }).queries_collapsed, undefined);
    assert.equal((clean as { note?: string }).note, undefined, "no lecture when the batch is clean");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * Codex-Gegenreview (P0): Zwei Sub-Ergebnisse können BEIDE `score_kind: "rrf"`
 * melden und trotzdem in verschiedenen Zahlenräumen liegen — eine Phrasierung
 * mit Commons-Treffern reicht bis 241.803, eine ohne bis 163.934. Der
 * Best-Score-Merge stellte den Dreiarm-Wert nach vorn, weil seine Skala höher
 * reicht, nicht weil er besser passte. Verglichen wird deshalb die ARMMENGE.
 */
test("verschiedene Armmengen werden über die Ränge fusioniert, nicht über die Zahlen", () => {
  const zweiarm = {
    hits: [{ id: "persoenlich", score: 160 }],
    score_kind: "rrf" as const,
    score_arms: ["bm25", "vector"],
    score_version: "rrf-1",
  };
  const dreiarm = {
    hits: [{ id: "mit-commons", score: 230 }],
    score_kind: "rrf" as const,
    score_arms: ["bm25", "commons", "vector"],
    score_version: "rrf-1",
  };

  const merged = mergeBatchResults(["a", "b"], [zweiarm, dreiarm], 5);
  assert.equal(merged.merged_by, "query-rank-fusion");
  assert.equal(merged.score_kind, "bm25", "gemischte Bauart trägt kein Band");
  assert.equal(merged.unfused, true);
  assert.equal(merged.score_arms, undefined);

  // Gleiche Armmenge bleibt dagegen der billige Best-Score-Merge.
  const gleich = mergeBatchResults(["a", "b"], [zweiarm, { ...zweiarm, hits: [{ id: "z", score: 90 }] }], 5);
  assert.equal(gleich.merged_by, "score");
  assert.equal(gleich.score_kind, "rrf");
  assert.deepEqual(gleich.score_arms, ["bm25", "vector"]);
  assert.equal(gleich.score_version, "rrf-1");
});

/**
 * 08.09.2026: Der Forwarder ließ die Skalenangaben des Daemons fallen, und der
 * Merge las die Abwesenheit fail-closed als „anderer Score-Raum". Ergebnis:
 * JEDER Batch war gemischt und meldete `unfused`, obwohl beide Arme liefen.
 */
test("projectRecallResult reicht Score-Raum und Ehrlichkeitsflags durch", () => {
  const out = projectRecallResult("q", {
    hits: [{ id: "a", score: 152.2 }],
    vault_size: 1149,
    recall_id: "r1",
    latency_ms: 61,
    score_kind: "rrf",
    score_arms: ["bm25", "vector"],
    score_version: "rrf-1",
    weak_result: true,
  });
  assert.equal(out.score_kind, "rrf");
  assert.deepEqual(out.score_arms, ["bm25", "vector"]);
  assert.equal(out.score_version, "rrf-1");
  assert.equal(out.weak_result, true);
  // Abwesendes bleibt abwesend — kein erfundenes `unfused: false`.
  assert.ok(!("unfused" in out));
  assert.ok(!("no_home" in out));
});

test("zwei fusionierte Sub-Ergebnisse aus dem Forwarder bleiben ein Score-Raum", () => {
  const sub = (id: string, score: number) =>
    projectRecallResult("q", {
      hits: [{ id, score }],
      vault_size: 1149,
      recall_id: id,
      latency_ms: 30,
      score_kind: "rrf",
      score_arms: ["bm25", "vector"],
      score_version: "rrf-1",
    }) as Parameters<typeof mergeBatchResults>[1][number];
  const merged = mergeBatchResults(["a", "b"], [sub("a", 152.2), sub("b", 124.9)], 5);
  assert.equal(merged.score_kind, "rrf");
  assert.equal(merged.merged_by, "score");
  assert.ok(!merged.unfused, "beide Arme liefen — der Batch darf kein Band absprechen");
});

test("ein degradiertes Sub-Ergebnis macht den Batch weiterhin bandlos", () => {
  const fused = projectRecallResult("a", {
    hits: [{ id: "a", score: 152.2 }],
    score_kind: "rrf",
    score_arms: ["bm25", "vector"],
    score_version: "rrf-1",
  }) as Parameters<typeof mergeBatchResults>[1][number];
  const degraded = projectRecallResult("b", {
    hits: [{ id: "b", score: 405585 }],
    score_kind: "bm25",
    unfused: true,
    degraded: "vector-deadline",
  }) as Parameters<typeof mergeBatchResults>[1][number];
  const merged = mergeBatchResults(["a", "b"], [fused, degraded], 5);
  assert.equal(merged.score_kind, "bm25");
  assert.equal(merged.unfused, true);
  assert.equal(merged.merged_by, "query-rank-fusion");
});
