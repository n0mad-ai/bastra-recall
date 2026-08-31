/**
 * Zwei Score-Räume, vier Merge-Pfade (Codex-Gegenreview).
 *
 * Läuft der Vektor-Arm, ist `score` eine skalierte Rang-Summe mit Obergrenze
 * 163.934 — die Bänder 50/100 bedeuten dort etwas. Fällt der Arm aus, kommen
 * ROHE BM25-Werte auf offener Skala (auf einem echten Vault sechsstellig).
 * `score_kind` / `unfused` tragen diesen Unterschied über die Leitung.
 *
 * Jeder Merge, der beide Räume numerisch vergleicht, wirft diese Information
 * weg und lässt den unbegrenzten Raum gewinnen — 405585 schlägt 160 immer,
 * ohne dass 405585 etwas Besseres wäre. Genau das prüfen die Tests hier, in
 * derselben Reihenfolge wie die vier Befunde:
 *
 *   1. mergeBatchResults        — Batch-Queries mit ungleich degradierten Armen
 *   2. fuseCommonsHits          — persönliche RRF-Scores gegen Commons-BM25
 *   3. /hook/recall content-arm — Prompt- und Content-Recall degradieren einzeln
 *   4. mergeHookRecallHits      — Belege aus dem Verlierer im Score-Gewinner
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/score-space-merges.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  type EmbeddingProvider,
  type RecallHit,
} from "@bastra-recall/core";
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import { mergeBatchResults } from "../src/recall-batch.js";
import { fuseCommonsHits } from "../src/commons-fusion.js";
import { mergeHookRecallHits } from "../src/http.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { extractCandidatePools, type TelemetryEvent } from "../src/learned-recall/harvest.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Obergrenze der fusionierten Skala: Rang 1 in beiden Armen. */
const RRF_CEILING = (2 * RRF_SCALE) / (RRF_K + 1);

/** Acht seltene Terme — ihr BM25-Rohwert liegt in einem 200er-Vault bei ~5643. */
const RARE_TERMS = ["zzalpha", "zzbeta", "zzgamma", "zzdelta", "zzepsilon", "zzzeta", "zzeta", "zztheta"];

function memoryMd(id: string, trigger: string, body: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${id} ${trigger}`,
    "type: lesson",
    `summary: ${trigger} summary`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test",
    "recall_when:",
    `  - ${trigger}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

// ─── Befund 1: Batch ───────────────────────────────────────────────────────

test("Befund 1 — mergeBatchResults: ungleich degradierte Arme sortieren nicht mehr über Räume hinweg", () => {
  // Der nachgestellte Fall: Query 1 lief hybrid (Rang-Summe, ≤163.934),
  // Query 2 fiel auf rohes BM25 zurück (offene Skala). Ein Score-Vergleich
  // stellt 405585 unbesehen an die Spitze.
  const merged = mergeBatchResults(
    ["hybrid phrasing", "degraded phrasing"],
    [
      { hits: [{ id: "a", score: 160 }, { id: "c", score: 120 }], recall_id: "r1", score_kind: "rrf" },
      { hits: [{ id: "b", score: 405585 }, { id: "a", score: 9 }], recall_id: "r2", score_kind: "bm25", unfused: true },
    ],
    5,
  );

  assert.equal(merged.hits[0]!.id, "a", "der in BEIDEN Phrasierungen hoch gerankte Hit führt, nicht der große Rohwert");
  assert.equal(merged.hits[1]!.id, "b");
  assert.equal(merged.hits[0]!.score, 160, "der ausgewiesene Score bleibt ein echter Einzelquery-Score");
  assert.equal(merged.merged_by, "query-rank-fusion", "die Reihenfolge kommt aus Rängen — und sagt das auch");

  // Fail-closed: gemischt heißt „kein Band". Ohne das kann eine Lane den
  // sechsstelligen Rohwert weiterhin als REQUIRED ausliefern.
  assert.equal(merged.score_kind, "bm25");
  assert.equal(merged.unfused, true);
});

test("Befund 1 — mergeBatchResults: gleicher Raum behält den Best-Score-Merge", () => {
  const merged = mergeBatchResults(
    ["q1", "q2"],
    [
      { hits: [{ id: "x", score: 50 }], recall_id: "r1", score_kind: "rrf" },
      { hits: [{ id: "x", score: 120 }, { id: "y", score: 40 }], recall_id: "r2", score_kind: "rrf" },
    ],
    5,
  );
  assert.equal(merged.hits[0]!.id, "x");
  assert.equal(merged.hits[0]!.score, 120, "vergleichbare Räume dürfen vergleichen");
  assert.equal(merged.merged_by, "score");
  assert.equal(merged.score_kind, "rrf");
  assert.equal(merged.unfused, undefined);
});

// ─── Befund 2: Commons ─────────────────────────────────────────────────────

test("Befund 2 — fuseCommonsHits: Commons ist eine zweite Rangliste, kein zweiter Zahlenraum", () => {
  const personal = [
    { id: "own", score: 160 } as unknown as RecallHit,
    { id: "own2", score: 90 } as unknown as RecallHit,
  ];
  const commons = [
    { id: "recipe", score: 405585 } as unknown as RecallHit,
  ];
  const fused = fuseCommonsHits(personal, commons, () => 0.8, { personalFused: false });

  assert.equal(fused[0]!.id, "own", "ein sechsstelliger BM25-Wert kauft keinen Rang — 0.8 × sechsstellig ist sechsstellig");
  assert.equal(fused[0]!.score, Math.round((RRF_SCALE / (RRF_K + 1)) * 1000) / 1000);
  // Rang 1 im Commons-Index (×0.8) landet hinter Rang 2 der persönlichen
  // Liste — der Rohwert 405585 kauft keinen einzigen Platz.
  assert.equal(fused[2]!.id, "recipe");
  assert.equal(fused[2]!.score, Math.round((0.8 * (RRF_SCALE / (RRF_K + 1))) * 1000) / 1000);
  for (const h of fused) {
    assert.ok(h.score <= (2 * RRF_SCALE) / (RRF_K + 1), "alles liegt unter der RRF-Obergrenze");
  }
});

test("Befund 2 — fuseCommonsHits: ID-Kollision behält das persönliche Memory und zählt beide Ränge", () => {
  const personal = [{ id: "same", score: 120, scope: "personal" } as unknown as RecallHit];
  const commons = [{ id: "same", score: 7, scope: "commons" } as unknown as RecallHit];
  const fused = fuseCommonsHits(personal, commons, () => 0.8, { personalFused: false });
  assert.equal(fused.length, 1, "keine Duplikate");
  assert.equal(fused[0]!.scope, "personal", "der persönliche Treffer gewinnt die Kollision");
  assert.equal(
    fused[0]!.score,
    Math.round((1.8 * (RRF_SCALE / (RRF_K + 1))) * 1000) / 1000,
    "Übereinstimmung beider Ranglisten hebt — genau das kann RRF und die Multiplikation nicht",
  );
});

test("Befund 2 — recallHandler: der Commons-Treffer erreicht den Caller auf der fusionierten Skala", async () => {
  const dirP = await mkdtemp(join(tmpdir(), "bastra-commons-fuse-p-"));
  const dirC = await mkdtemp(join(tmpdir(), "bastra-commons-fuse-c-"));
  try {
    await writeFile(join(dirP, "own.md"), memoryMd("own-note", "flux compensator drift tuning", "Body own."), "utf8");
    await writeFile(join(dirC, "recipe.md"), memoryMd("spinner-recipe", "button spinner clipped width jumps", "Body recipe."), "utf8");

    const vault = new Vault(dirP);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    const commonsVault = new Vault(dirC);
    await commonsVault.init();
    const commonsSearch = new SearchIndex(commonsVault);
    commonsSearch.start();
    const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dirP, commonsSearch };

    const res = await recallHandler(deps, { query: "button spinner clipped width jumps", k: 5 });
    const recipe = (res.hits as { id: string; score: number }[]).find((h) => h.id === "spinner-recipe");
    assert.ok(recipe, "das Rezept muss weiterhin auftauchen");
    assert.equal(
      recipe.score,
      Math.round(0.8 * (RRF_SCALE / (RRF_K + 1)) * 1000) / 1000,
      "kein roher BM25-Wert × 0.8 mehr, sondern der gewichtete Rang-Beitrag",
    );
    assert.equal(res.score_kind, "rrf", "die servierte Zahl liegt in der fusionierten Rang-Skala");

    search.stop();
    commonsSearch.stop();
    await vault.stop?.();
    await commonsVault.stop?.();
  } finally {
    await rm(dirP, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(dirC, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ─── Befund 4: Evidence-Bundle ─────────────────────────────────────────────

test("Befund 4 — mergeHookRecallHits: Belege bleiben beim Score-Gewinner, kein Anker aus dem Verlierer", () => {
  const base: RecallHit = {
    id: "same",
    title: "same",
    type: "reference",
    scope: "fremdes-projekt",
    summary: "same",
    topic_path: [],
    score: 150,
    matched_terms: ["prompt"],
    matched_recall_when: false,
  };
  const contentHit: RecallHit = {
    ...base,
    score: 80,
    matched_terms: ["content"],
    matched_recall_when: true,
    anchor_strength: "weak",
  };

  const merged = mergeHookRecallHits([base], [contentHit], 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.score, 150);
  assert.deepEqual(merged[0]!.matched_terms, ["prompt"], "der Matchbeweis gehört zu der Query, die ihn erzeugt hat");
  assert.equal(
    merged[0]!.matched_recall_when,
    false,
    "sonst entsteht ein Treffer mit Score 150 UND Triggerbeleg, den keiner der beiden Recalls je hatte",
  );
  assert.equal(merged[0]!.anchor_strength, undefined);
});

// ─── Befund 3: Prompt- und Content-Recall degradieren einzeln ──────────────

class SelectiveSlowProvider implements EmbeddingProvider {
  readonly id = "selective-mock";
  readonly dim = 3;
  /** Exakter Text, für den der Provider hängt — Dokumenttexte treffen ihn nie. */
  public slowFor: string | null = null;
  public delayMs = 400;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.slowFor !== null && texts.some((t) => t === this.slowFor)) await sleep(this.delayMs);
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

function hookRecall(port: number, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/hook/recall",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve(JSON.parse(out || "{}")));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("Befund 3 — /hook/recall: ein degradierter Content-Arm mischt seine rohen Scores nicht unter", async (t) => {
  // Der Vault ist absichtlich groß genug, damit rohes BM25 sichtbar aus dem
  // fusionierten Band herausläuft: 200 Füller-Memories + ein Treffer auf acht
  // seltenen Termen ergeben gemessen ~5643 — die RRF-Skala endet bei 163.934.
  const dir = await mkdtemp(join(tmpdir(), "bastra-content-space-"));
  const folder = join(dir, "memories");
  await mkdir(folder, { recursive: true });
  for (let i = 0; i < 200; i++) {
    await writeFile(join(folder, `f${i}.md`), memoryMd(`filler-${i}`, `filler topic ${i}`, `Body filler ${i}.`), "utf8");
  }
  await writeFile(join(folder, "p.md"), memoryMd("prompt-hit", "ANCHORWORD", "Body ANCHORWORD."), "utf8");
  await writeFile(
    join(folder, "c.md"),
    memoryMd("content-hit", RARE_TERMS.join(" "), `${RARE_TERMS.join(" ")} ${RARE_TERMS.join(" ")}`),
    "utf8",
  );

  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const provider = new SelectiveSlowProvider();
  const emb = new EmbeddingIndex(vault, provider, join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  search.useEmbeddings(emb);
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: true, providerId: "selective-mock", source: "env" },
  });

  const prevContent = process.env.BASTRA_HOOK_CONTENT_RECALL;
  const prevDeadline = process.env.BASTRA_VECTOR_DEADLINE_MS;
  t.after(async () => {
    if (prevContent === undefined) delete process.env.BASTRA_HOOK_CONTENT_RECALL;
    else process.env.BASTRA_HOOK_CONTENT_RECALL = prevContent;
    if (prevDeadline === undefined) delete process.env.BASTRA_VECTOR_DEADLINE_MS;
    else process.env.BASTRA_VECTOR_DEADLINE_MS = prevDeadline;
    await handle.close();
    await emb.stop();
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  process.env.BASTRA_HOOK_CONTENT_RECALL = "1";
  process.env.BASTRA_VECTOR_DEADLINE_MS = "40";
  // NUR die Content-Query hängt: der Prompt-Recall fusioniert, der
  // Content-Recall läuft in die Deadline und liefert rohes BM25.
  const contentQuery = RARE_TERMS.join(" ");
  provider.slowFor = contentQuery;

  const body = await hookRecall(handle.port!, {
    query: "ANCHORWORD",
    tool_input_excerpt: contentQuery,
    tool_name: "Write",
    k: 3,
    session_id: "content-space-test",
  });

  const hits = body.hits as { id: string; score: number }[];
  assert.ok(hits.length > 0, "der fusionierte Prompt-Recall bleibt vollständig");
  assert.equal(body.score_kind, "rrf", "der Modus beschreibt die servierten Zahlen");
  assert.equal(body.unfused, undefined);
  for (const h of hits) {
    assert.ok(
      h.score <= RRF_CEILING,
      `${h.id} trägt ${h.score} — ein roher BM25-Wert in einer als "rrf" gemeldeten Liste`,
    );
  }
});

// ─── Befund A: Commons darf die persönliche Arm-Einigung nicht einebnen ────

test("Befund A — fuseCommonsHits(personalFused): der persönliche Score überlebt die Commons-Runde", () => {
  // Rang 1 in BEIDEN persönlichen Armen = 163.934. Die alte Fassung reduzierte
  // diesen Treffer auf seinen LISTENRANG und servierte 81.967 — die Einigung
  // zweier Arme war weg, obwohl Commons zu diesem Hit gar nichts gesagt hat.
  const twoArmed = (2 * RRF_SCALE) / (RRF_K + 1);
  const oneArmed = RRF_SCALE / (RRF_K + 1);
  const personal = [
    { id: "own", score: Math.round(twoArmed * 1000) / 1000, rrf: { rank_bm25: 1, rank_vector: 1, raw: 1 / 3 } } as unknown as RecallHit,
  ];
  const commons = [{ id: "recipe", score: 405585 } as unknown as RecallHit];

  const fused = fuseCommonsHits(personal, commons, () => 0.8, { personalFused: true });

  assert.equal(fused[0]!.id, "own");
  assert.equal(fused[0]!.score, Math.round(twoArmed * 1000) / 1000, "unverändert — Commons hat zu diesem Hit nichts beigetragen");
  assert.equal(fused[1]!.id, "recipe");
  assert.equal(fused[1]!.score, Math.round(0.8 * oneArmed * 1000) / 1000);
});

test("Befund A — fuseCommonsHits(personalFused): die ID-Kollision addiert auf den bestehenden Score", () => {
  const oneArmed = RRF_SCALE / (RRF_K + 1);
  const personal = [{ id: "same", score: 163.934, scope: "personal", rrf: { rank_bm25: 1, rank_vector: 1, raw: 1 / 3 } } as unknown as RecallHit];
  const fused = fuseCommonsHits(personal, [{ id: "same", score: 7 } as unknown as RecallHit], () => 0.8, {
    personalFused: true,
  });
  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.scope, "personal");
  assert.equal(fused[0]!.score, Math.round((163.934 + 0.8 * oneArmed) * 1000) / 1000);
});

test("Befund A — fuseCommonsHits(personalFused): der rrf-Beleg überlebt, sonst kippt no_home", () => {
  // `isNoHome` verlangt den `rrf`-Block. Wurde er beim Commons-Merge entfernt,
  // meldete derselbe Recall mit aktivierten Commons plötzlich no_home=false.
  const personal = [{ id: "own", score: 81.967, rrf: { rank_bm25: 1, rank_vector: null, raw: 1 / 6 } } as unknown as RecallHit];
  const fused = fuseCommonsHits(personal, [{ id: "recipe", score: 5 } as unknown as RecallHit], () => 0.8, {
    personalFused: true,
  });
  const own = fused.find((h) => h.id === "own")!;
  assert.deepEqual(own.rrf, { rank_bm25: 1, rank_vector: null, raw: 1 / 6 }, "der Beleg beschreibt weiterhin den persönlichen Anteil");
});

test("Befund A — recallHandler: ein REQUIRED-Treffer bleibt mit Commons REQUIRED", async () => {
  const dirP = await mkdtemp(join(tmpdir(), "bastra-commons-req-p-"));
  const dirC = await mkdtemp(join(tmpdir(), "bastra-commons-req-c-"));
  try {
    await writeFile(join(dirP, "own.md"), memoryMd("own-note", "flux compensator drift tuning", "Body own."), "utf8");
    await writeFile(join(dirC, "recipe.md"), memoryMd("spinner-recipe", "flux compensator drift tuning", "Body recipe."), "utf8");

    const vault = new Vault(dirP);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    const provider = new SelectiveSlowProvider();
    const emb = new EmbeddingIndex(vault, provider, join(dirP, ".bastra", "embeddings.json"));
    await emb.start();
    search.useEmbeddings(emb);
    const commonsVault = new Vault(dirC);
    await commonsVault.init();
    const commonsSearch = new SearchIndex(commonsVault);
    commonsSearch.start();
    const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dirP, commonsSearch };

    const res = await recallHandler(deps, { query: "flux compensator drift tuning", k: 5, min_score: 100 });
    const hits = res.hits as { id: string; score: number }[];
    assert.ok(
      hits.some((h) => h.id === "own-note"),
      "das persönliche Memory ist Rang 1 in beiden Armen — mit min_score=100 darf Commons es nicht wegdrücken",
    );
    assert.equal(
      hits.find((h) => h.id === "own-note")!.score,
      Math.round(RRF_CEILING * 1000) / 1000,
      "der Score ist exakt der beidarmige Anker — die Commons-Runde lässt ihn unangetastet",
    );
    assert.equal(res.score_kind, "rrf");

    commonsSearch.stop();
    await emb.stop();
    search.stop();
    await vault.stop?.();
    await commonsVault.stop?.();
  } finally {
    await rm(dirP, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(dirC, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ─── Befund B: gemischter Batch trägt den Raum pro Hit ────────────────────

test("Befund B — mergeBatchResults: im gemischten Batch nennt JEDER Hit seinen Raum", () => {
  const merged = mergeBatchResults(
    ["hybrid phrasing", "degraded phrasing"],
    [
      { hits: [{ id: "a", score: 160 }, { id: "c", score: 120 }], recall_id: "r1", score_kind: "rrf" },
      { hits: [{ id: "b", score: 405585 }, { id: "a", score: 9 }], recall_id: "r2", score_kind: "bm25", unfused: true },
    ],
    5,
  );
  const byId = new Map(merged.hits.map((h) => [h.id, h]));
  assert.equal(byId.get("a")!.score_kind, "rrf", "160 kam aus der fusionierten Phrasierung");
  assert.equal(byId.get("b")!.score_kind, "bm25", "405585 ist ein roher Wert und sagt das selbst");
  assert.equal(byId.get("c")!.score_kind, "rrf");
});

// ─── Befund C: Telemetrie speichert keine Zahl ohne ihren Raum ─────────────

test("Befund C — recall-Event trägt den Raum von top_score UND candidate_pool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-telemetry-space-"));
  try {
    await writeFile(join(dir, "own.md"), memoryMd("own-note", "flux compensator drift tuning", "Body own."), "utf8");
    const vault = new Vault(dir);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    const telemetry = new Telemetry();
    const logged: Record<string, unknown>[] = [];
    const orig = telemetry.logRecall.bind(telemetry);
    telemetry.logRecall = async (e: Parameters<typeof orig>[0]) => {
      logged.push(e as unknown as Record<string, unknown>);
    };
    const deps: ToolDeps = { vault, search, telemetry, vaultPath: dir };

    await recallHandler(deps, { query: "flux compensator drift tuning", k: 5 });
    await sleep(20);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.score_kind, "bm25", "ohne Vektor-Arm ist top_score ein roher Wert");
    assert.equal(logged[0]!.candidate_pool_score_kind, "bm25", "und der Pool liegt im selben rohen Raum");
    // Codex-Gegenreview (P1): `score_kind` allein ist zu grob — der Pool muss
    // seine volle Signatur tragen (Kind + Armmenge + Version).
    assert.deepEqual(logged[0]!.candidate_pool_score_arms, ["bm25"], "der Pool nennt seine Armmenge");
    assert.equal(
      logged[0]!.candidate_pool_score_version,
      undefined,
      "auf roher BM25-Skala gibt es keine Formelversion — dieselbe Regel wie beim Haupt-Score",
    );

    search.stop();
    await vault.stop?.();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ─── Befund D: Scope-Identität ist eine Entscheidung, nicht ein === ────────

test("Befund D — recallHandler: scope 'Commons' zählt als Commons-Scope", async () => {
  const dirP = await mkdtemp(join(tmpdir(), "bastra-commons-case-p-"));
  const dirC = await mkdtemp(join(tmpdir(), "bastra-commons-case-c-"));
  try {
    await writeFile(join(dirC, "recipe.md"), memoryMd("spinner-recipe", "button spinner clipped width jumps", "Body recipe."), "utf8");
    const vault = new Vault(dirP);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    const commonsVault = new Vault(dirC);
    await commonsVault.init();
    const commonsSearch = new SearchIndex(commonsVault);
    commonsSearch.start();
    const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dirP, commonsSearch };

    const res = await recallHandler(deps, { query: "button spinner clipped width jumps", k: 5, scope: "Commons" });
    assert.ok(
      (res.hits as { id: string }[]).some((h) => h.id === "spinner-recipe"),
      "eine großgeschriebene Schreibweise desselben Scopes darf den Commons-Index nicht abschalten",
    );

    commonsSearch.stop();
    search.stop();
    await vault.stop?.();
    await commonsVault.stop?.();
  } finally {
    await rm(dirP, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(dirC, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * Codex-Gegenreview: Auf dem KOLLAPS-Pfad (persönlicher Arm degradiert) plus
 * Commons-ID-Übereinstimmung fehlte das Evidence-Bundle vollständig. Heraus kam
 * `147.541` — und kein `rrf`, kein `rank_commons`, kein `personal_score`, die
 * diese Zahl erklärt hätten.
 *
 * Die Ränge, aus denen der Score hier gebildet wird, sind bekannt; also gehören
 * sie auch in den Beleg. `rank_bm25`/`rank_vector` bleiben `null`: Auf diesem
 * Pfad geht nicht der persönliche Zahlenwert ein, sondern nur sein LISTENRANG.
 */
test("Befund E — fuseCommonsHits(collapse): der Score erklärt sich auch auf dem Kollaps-Pfad", () => {
  const personal = [{ id: "same", score: 120, scope: "personal" } as unknown as RecallHit];
  const commons = [{ id: "same", score: 7, scope: "commons" } as unknown as RecallHit];
  const fused = fuseCommonsHits(personal, commons, () => 0.8, { personalFused: false });

  const rrf = fused[0]!.rrf;
  assert.ok(rrf, "ohne Beleg ist die Zahl unerklärt");
  assert.equal(rrf!.rank_personal_list, 1, "Rang 1 in der persönlichen Liste");
  assert.equal(rrf!.rank_bm25, null, "der persönliche ZAHLENWERT geht hier nicht ein");
  assert.equal(rrf!.rank_vector, null);
  assert.equal(rrf!.rank_commons, 1);
  assert.equal(rrf!.commons_weight, 0.8);
  assert.equal(
    rrf!.personal_score,
    Math.round((RRF_SCALE / (RRF_K + 1)) * 1000) / 1000,
    "der Anteil ohne Commons muss ablesbar bleiben",
  );
  // Und der Beleg muss die ausgelieferte Zahl auch wirklich tragen.
  assert.equal(
    fused[0]!.score,
    Math.round((rrf!.personal_score! + 0.8 * (RRF_SCALE / (RRF_K + 1))) * 1000) / 1000,
  );
});

/**
 * Codex-Gegenreview (Vertragsfehler): `rrf.raw` erklärte den ausgelieferten
 * Score nicht mehr.
 *
 * `fuseCommonsHits` addierte den Commons-Beitrag auf den Score, ließ das
 * Beleg-Feld aber stehen. Gemessen: ausgeliefert `225.574`, während
 * `rrf.raw × RRF_SCALE` weiter `160` ergab; auf dem Kollapspfad `147.541`
 * gegen `81.967`. Der dokumentierte Vertrag in `search.ts` lautet aber
 * „unskalierter RRF-Wert vor der RRF_SCALE-Skalierung, die `score` ergibt".
 *
 * Der Vertrag ist zugunsten des MITFÜHRENS entschieden: `raw` erklärt die Zahl,
 * die wirklich rausgeht; wer den Anteil ohne Commons will, liest
 * `personal_score`.
 */
const reconstructed = (hit: RecallHit): number => Math.round(hit.rrf!.raw * RRF_SCALE * 1000) / 1000;

test("Befund F — fuseCommonsHits(personalFused): rrf.raw × RRF_SCALE ergibt wieder den Score", () => {
  const personal = [
    { id: "same", score: 163.934, rrf: { rank_bm25: 1, rank_vector: 1, raw: 2 / (RRF_K + 1) } } as unknown as RecallHit,
  ];
  const fused = fuseCommonsHits(personal, [{ id: "same", score: 405585 } as unknown as RecallHit], () => 0.8, {
    personalFused: true,
  });

  const hit = fused[0]!;
  assert.ok(hit.rrf, "ohne Beleg ist die Zahl unerklärt");
  assert.equal(reconstructed(hit), hit.score, "der Beleg muss den ausgelieferten Score tragen");
  assert.equal(
    hit.rrf!.personal_score,
    163.934,
    "und der Anteil ohne Commons bleibt getrennt lesbar",
  );
});

test("Befund F — fuseCommonsHits(collapse): rrf.raw trägt auch den kollabierten Score", () => {
  const personal = [{ id: "same", score: 120, scope: "personal" } as unknown as RecallHit];
  const fused = fuseCommonsHits(personal, [{ id: "same", score: 7 } as unknown as RecallHit], () => 0.8, {
    personalFused: false,
  });

  const hit = fused[0]!;
  assert.equal(reconstructed(hit), hit.score);
});

test("Befund F — fuseCommonsHits: ein Treffer NUR aus den Commons erklärt sich ebenfalls", () => {
  const fused = fuseCommonsHits([], [{ id: "recipe", score: 405585 } as unknown as RecallHit], () => 0.95, {
    personalFused: true,
  });

  const hit = fused[0]!;
  assert.equal(reconstructed(hit), hit.score);
  assert.equal(hit.rrf!.personal_score, 0);
});

// ─── Befund P1: der Candidate-Pool trägt seine Armmenge ───────────────────

/** Baut ein recall-Event mit frei wählbarer Signatur für top_score und Pool. */
function poolEvent(over: Record<string, unknown>): TelemetryEvent {
  return {
    kind: "recall",
    ts: new Date().toISOString(),
    query: "warum schließt sich mein Panel beim Dialog",
    candidate_pool: [
      { id: "a", score: 80 },
      { id: "b", score: 12 },
    ],
    ...over,
  };
}

test("Befund P1 — extractCandidatePools: drei Arme im top_score sind kein Pool-Score", () => {
  // Die gemessene Gegenprobe: top_score 150 aus bm25+commons+vector (Skala bis
  // 241.803), Pool-Spitzenwert 80 aus bm25+vector (bis 163.934). Beide melden
  // `"rrf"` — vorher galten sie deshalb als derselbe Raum und der Harvester las
  // 150. Der `< maxScore`-Schnitt (100) sah damit einen starken Treffer, den es
  // im Pool-Raum nie gab, und der schwache Recall ging nie ins Reranking.
  const [entry] = extractCandidatePools([
    poolEvent({
      top_score: 150,
      score_kind: "rrf",
      score_arms: ["bm25", "commons", "vector"],
      score_version: "rrf-1",
      candidate_pool_score_kind: "rrf",
      candidate_pool_score_arms: ["bm25", "vector"],
      candidate_pool_score_version: "rrf-1",
    }),
  ]);
  assert.equal(entry!.topScore, 80, "verschiedene Armmengen → top_score ist im Pool-Raum nicht lesbar");
  assert.deepEqual(entry!.scoreArms, ["bm25", "vector"], "der gemeldete Raum ist der des Pools");
  assert.ok(entry!.topScore < 100, "und der Fall gilt weiterhin als far — genau darum ging es");
});

test("Befund P1 — identische Signatur: top_score bleibt lesbar", () => {
  const [entry] = extractCandidatePools([
    poolEvent({
      top_score: 150,
      score_kind: "rrf",
      score_arms: ["bm25", "vector"],
      score_version: "rrf-1",
      candidate_pool_score_kind: "rrf",
      candidate_pool_score_arms: ["bm25", "vector"],
      candidate_pool_score_version: "rrf-1",
    }),
  ]);
  assert.equal(entry!.topScore, 150, "gleiche Armmenge + gleiche Version → derselbe Raum");
  assert.equal(entry!.scoreVersion, "rrf-1");
});

test("Befund P1 — fehlende Felder heißen unbekannt, nicht gleich (fail-closed)", () => {
  // Altbestand: `score_kind` auf beiden Seiten, aber keine Armmenge. Vorher
  // reichte das für „selber Raum". Ein fehlender Wert ist keine Zusage.
  const [old] = extractCandidatePools([
    poolEvent({ top_score: 150, score_kind: "rrf", candidate_pool_score_kind: "rrf" }),
  ]);
  assert.equal(old!.topScore, 80, "ohne Armmenge ist die Vergleichbarkeit unbekannt → Pool-Spitzenwert");

  // Nur eine Seite nennt die Armmenge: ebenfalls unbekannt.
  const [half] = extractCandidatePools([
    poolEvent({
      top_score: 150,
      score_kind: "rrf",
      score_arms: ["bm25", "vector"],
      score_version: "rrf-1",
      candidate_pool_score_kind: "rrf",
    }),
  ]);
  assert.equal(half!.topScore, 80);

  // Gleiche Arme, aber verschiedene Formelversion: die Zahl hat dazwischen ihre
  // Bedeutung geändert.
  const [ver] = extractCandidatePools([
    poolEvent({
      top_score: 150,
      score_kind: "rrf",
      score_arms: ["bm25", "vector"],
      score_version: "rrf-2",
      candidate_pool_score_kind: "rrf",
      candidate_pool_score_arms: ["bm25", "vector"],
      candidate_pool_score_version: "rrf-1",
    }),
  ]);
  assert.equal(ver!.topScore, 80);
});
