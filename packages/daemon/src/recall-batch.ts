/**
 * #351: recall batch mode — several phrasings, ONE round trip.
 *
 * The model's ad-hoc call volume was the frequency half of #342 (zzalli:
 * blocking cost per turn ≈ calls × latency; the latency half shipped as the
 * vector deadline). Batching turns N proactive recalls into one tool call.
 *
 * Merge discipline: results interleave by the BEST original score per hit —
 * deliberately NOT re-fused into a new scale (RRF across queries), because
 * the tool description's 30/100 score bands are a contract the model acts
 * on; every returned score must remain a real single-query score.
 *
 * Das gilt, SOLANGE alle Phrasierungen im selben Score-Raum landen. Tun sie es
 * nicht (eine degradiert, die andere fusioniert), ist ein Score-Vergleich
 * bedeutungslos; dann bestimmen die Ränge die Reihenfolge und der Response sagt
 * das ausdrücklich — siehe `mergeBatchResults`.
 */

import { RRF_K } from "@bastra-recall/core/rrf";

import { contentTokens } from "./save-similarity.js";

// ─── near-duplicate guard (zzalli's field report on #351) ───────────────────
// The design hope was 2-4 REAL paraphrases of one intent. What models send on
// a convoluted prompt is the opposite: every concept packed into query 1,
// then near-duplicate remixes of the same tokens. Those pay full search
// latency per sub-query and buy no fusion gain — so they are collapsed
// BEFORE searching, and the result carries a corrective note.

/** Two queries whose content-token Jaccard reaches this are the same intent
 *  in remixed words. Deliberately high: a GOOD paraphrase shares few content
 *  tokens (different vocabulary is the whole point of paraphrasing). */
export const BATCH_DUPLICATE_MIN = 0.6;

/** Jaccard overlap of the content-token sets (unicode-aware, umlaut-folded,
 *  stopword-free — same view the save-similarity lane compares with). */
export function queryOverlap(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export interface BatchDedupe {
  /** Queries that actually run, in original order (first occurrence wins). */
  kept: string[];
  /** Near-duplicates that were collapsed away. */
  collapsed: string[];
  /** Highest pairwise overlap across ALL submitted queries — the telemetry
   *  measure for how paraphrase-shaped the model's batches really are. */
  max_overlap: number;
}

export function dedupeQueries(queries: string[]): BatchDedupe {
  const kept: string[] = [];
  const collapsed: string[] = [];
  let maxOverlap = 0;
  for (const q of queries) {
    let duplicate = false;
    for (const k of kept) {
      const overlap = queryOverlap(q, k);
      if (overlap > maxOverlap) maxOverlap = overlap;
      if (overlap >= BATCH_DUPLICATE_MIN) duplicate = true;
    }
    (duplicate ? collapsed : kept).push(q);
  }
  return { kept, collapsed, max_overlap: Math.round(maxOverlap * 100) / 100 };
}

/** The corrective note a collapsed batch carries back to the model. */
export function batchDuplicateNote(collapsedCount: number, total: number): string {
  return (
    `${collapsedCount} of ${total} queries were near-duplicates and were collapsed before searching. ` +
    `Each query in a batch must carry ONE distinct intent: a real paraphrase in different vocabulary, ` +
    `or a cleanly separated sub-question. Do not remix the same concepts into several queries.`
  );
}

export type BatchHit = { id: string; score: number } & Record<string, unknown>;

export interface BatchSubResult {
  hits?: BatchHit[];
  vault_size?: number;
  recall_id?: string;
  weak_result?: boolean;
  no_home?: boolean;
  /** In welchem Score-Raum `hits[].score` DIESER Sub-Query liegt. */
  score_kind?: "rrf" | "bm25";
  /** Kurzform von `score_kind === "bm25"`. */
  unfused?: boolean;
  /** Welche ARME die Zahl gebildet haben. Feiner als `score_kind` und seit
   *  dem Commons-Arm die eigentlich entscheidende Angabe — siehe
   *  {@link signatureOf}. */
  score_arms?: string[];
  /** Version der Score-Formel. */
  score_version?: string;
}

export interface BatchMerged {
  query: string;
  query_count: number;
  vault_size: number | undefined;
  hits: BatchHit[];
  recall_id: string | undefined;
  recall_ids: string[];
  weak_result?: true;
  no_home?: true;
  /** Der Score-Raum, in dem die zurückgegebenen Zahlen zu lesen sind. Nie
   *  optional: eine fehlende Angabe war genau der Weg, auf dem rohe BM25-Werte
   *  als Rang-Summen gelesen wurden. */
  score_kind: "rrf" | "bm25";
  /** Die Armmenge, in der alle Sub-Ergebnisse lagen — nur gesetzt, wenn sie
   *  überhaupt dieselbe war. */
  score_arms?: string[];
  /** Version der Score-Formel, ebenfalls nur bei einheitlicher Bauart. */
  score_version?: string;
  unfused?: true;
  /** Woraus die Reihenfolge entstanden ist — `"score"` nur, wenn alle
   *  Sub-Ergebnisse im selben Raum lagen. */
  merged_by: "score" | "query-rank-fusion";
}

/** Der Raum EINES Sub-Ergebnisses. Fail-closed: Sagt ein Sub-Ergebnis nichts,
 *  gilt der unbegrenzte Raum — die Bänder dürfen nur greifen, wenn jemand
 *  ausdrücklich zusichert, dass sie etwas beschreiben. */
function spaceOf(s: BatchSubResult): "rrf" | "bm25" {
  if (s.unfused === true) return "bm25";
  return s.score_kind ?? "bm25";
}

/**
 * Die VERGLEICHBARKEITS-Signatur eines Sub-Ergebnisses: Formelversion plus
 * Armmenge, sonst der Score-Raum.
 *
 * Codex-Gegenreview (P0): Verglichen wurde nur `score_kind`, und seit dem
 * Commons-Arm heißen mehrere verschiedene Zahlen `"rrf"` — BM25+Vector
 * (≤163.934), BM25+Vector+Commons (≤241.803), Kollaps-Rang+Commons (≤147.541).
 * Zwei Phrasierungen, von denen eine Commons-Treffer hatte und die andere
 * nicht, wurden damit per Best-Score gegeneinandergestellt: Der Dreiarm-Wert
 * gewann, weil seine Skala höher reicht, nicht weil er besser passte. Gleiche
 * Zahl, gleiche Bauart — sonst wird über die RÄNGE fusioniert.
 */
function signatureOf(s: BatchSubResult, index: number): string {
  const space = spaceOf(s);
  // Codex-Gegenreview (P0): Alle BM25-Sub-Queries galten hier als DERSELBE
  // Raum und wurden per Best-Score zusammengeführt. Rohe BM25-Werte sind aber
  // auch untereinander nicht vergleichbar: Termzahl, Querylänge und Expansion
  // verschieben die absolute Höhe, ohne dass der Treffer besser passt. Genau
  // deshalb war der Batch-Pfad auf Maschinen OHNE Embedding-Modell — also dem
  // Fall, in dem jede Antwort unfused ist — durchgehend falsch.
  //
  // Jede unfused Liste bekommt deshalb ihre eigene Signatur: vergleichbar ist
  // sie nur mit sich selbst, und der Merge geht über die Ränge.
  if (space === "bm25") return `bm25/${index}`;
  const arms = s.score_arms ? [...s.score_arms].sort().join("+") : "rrf-unspecified";
  return `${s.score_version ?? "unversioned"}/${arms}`;
}

/**
 * Merge über mehrere Phrasierungen (#351).
 *
 * Codex-Gegenreview: Die Sub-Queries laufen als eigenständige Recalls, und ein
 * einzelner Ollama-Aufruf kann degradieren, während die anderen fusionieren.
 * Dann liegt Query 1 auf der RRF-Skala (≤163.934) und Query 2 auf roher
 * BM25-Skala (sechsstellig). Der alte Best-Score-Merge stellte 405585
 * vor 160 — nicht weil der Treffer besser war, sondern weil seine Skala keine
 * Obergrenze hat. Der zusammengeführte Response trug außerdem WEDER
 * `score_kind` NOCH `unfused`, sodass die Lanes den Rohwert bandeten.
 *
 * Deshalb zwei getrennte Fälle:
 *   - EIN Raum: Best-Score-Merge wie bisher. Die Zahlen sind vergleichbar, und
 *     jeder ausgewiesene Score bleibt ein echter Einzelquery-Score (das ist die
 *     Zusage im Kopfkommentar dieser Datei).
 *   - GEMISCHT: Die Reihenfolge kommt aus einer RRF über die RÄNGE der
 *     Sub-Listen — das Einzige, was zwischen den Räumen vergleichbar ist. Die
 *     ausgewiesenen Scores bleiben die echten Einzelquery-Werte, aber der
 *     Response meldet fail-closed `bm25`/`unfused`: gemischt heißt „kein Band".
 *     Zusätzlich trägt JEDER Hit sein eigenes `score_kind` — der eine Wert oben
 *     beschreibt die gemischte Liste nicht, und ohne die Pro-Hit-Angabe steht
 *     ein echter Einzelquery-Score da, dessen Skala niemand nennen kann.
 *
 * weak_result/no_home überleben weiterhin nur, wenn JEDES Sub-Ergebnis sie
 * trug — eine verankerte Phrasierung macht den Batch beantwortbar.
 */
export function mergeBatchResults(queries: string[], subs: BatchSubResult[], k: number): BatchMerged {
  const recallIds: string[] = [];
  let vaultSize: number | undefined;
  let weakAll = true;
  let noHomeAll = true;
  const spaces = new Set<"rrf" | "bm25">();
  const signatures = new Set<string>();
  for (const [index, s] of subs.entries()) {
    if (typeof s.vault_size === "number") vaultSize = s.vault_size;
    if (typeof s.recall_id === "string") recallIds.push(s.recall_id);
    if (s.weak_result !== true) weakAll = false;
    if (s.no_home !== true) noHomeAll = false;
    spaces.add(spaceOf(s));
    signatures.add(signatureOf(s, index));
  }
  // Gemischt heißt jetzt „nicht dieselbe Bauart", nicht nur „nicht derselbe
  // Score-Raum": Zwei `rrf`-Listen mit verschiedenen Armmengen sind ebenso
  // wenig per Zahl vergleichbar wie eine RRF- und eine BM25-Liste.
  const mixed = signatures.size > 1;
  // Fail-closed wie bei gemischten Räumen: Verschiedene Armmengen heißt „kein
  // Band". Die ausgewiesenen Zahlen bleiben echte Einzelquery-Scores, aber
  // niemand darf 100 darauf anwenden, wenn 100 in der einen Liste etwas
  // anderes bedeutet als in der anderen.
  const scoreKind: "rrf" | "bm25" = !mixed && spaces.size === 1 ? [...spaces][0]! : "bm25";

  const hits = mixed ? fuseByQueryRank(subs, k) : mergeByScore(subs, k);
  return {
    query: queries.join(" | "),
    query_count: queries.length,
    vault_size: vaultSize,
    hits,
    recall_id: recallIds[0],
    recall_ids: recallIds,
    ...(weakAll && subs.length > 0 ? { weak_result: true as const } : {}),
    ...(noHomeAll && subs.length > 0 ? { no_home: true as const } : {}),
    score_kind: scoreKind,
    ...(mixed ? {} : { score_arms: subs[0]?.score_arms, score_version: subs[0]?.score_version }),
    ...(scoreKind === "bm25" ? { unfused: true as const } : {}),
    merged_by: mixed ? "query-rank-fusion" : "score",
  };
}

/** Ein Raum: dedupe by id, bester Score gewinnt, resort, auf k schneiden. */
function mergeByScore(subs: BatchSubResult[], k: number): BatchHit[] {
  const best = new Map<string, BatchHit>();
  for (const s of subs) {
    for (const h of s.hits ?? []) {
      const existing = best.get(h.id);
      if (!existing || h.score > existing.score) best.set(h.id, h);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Gemischte Räume: Reihenfolge aus den Rängen (RRF), Scores bleiben echt.
 *  Das ausgewiesene Hit-Objekt ist das aus der Sub-Query, in der der Treffer am
 *  BESTEN rankte — ein echter Score aus einem benennbaren Recall, statt einer
 *  Zahl, die aus zwei Skalen zusammengerechnet wurde. */
function fuseByQueryRank(subs: BatchSubResult[], k: number): BatchHit[] {
  const fused = new Map<string, { hit: BatchHit; rank: number; rrf: number }>();
  for (const s of subs) {
    const space = spaceOf(s);
    (s.hits ?? []).forEach((h, index) => {
      const rank = index + 1;
      const contribution = 1 / (RRF_K + rank);
      // Zweiter Gegenreview: `unfused` auf dem Response verhindert das Banding,
      // aber der eine `score_kind` oben beschreibt hier NICHT alle Hits — die
      // Liste kann 160 (fusioniert) und 405585 (roh) direkt hintereinander
      // führen. Jeder Hit nennt deshalb den Raum SEINER Zahl; ohne das ist ein
      // ausgewiesener Einzelquery-Score im gemischten Batch nicht lesbar.
      // Codex-Gegenreview: `score_kind` allein reichte auch hier nicht. Zwei
      // Hits können beide `rrf` sein und trotzdem aus verschiedenen Armmengen
      // stammen — 163.934 gedeckelt neben 241.803 gedeckelt. Jeder Hit nennt
      // deshalb die Bauart SEINER Zahl, nicht nur ihren Raum.
      const tagged: BatchHit = {
        ...h,
        score_kind: space,
        ...(space === "rrf" && s.score_arms ? { score_arms: s.score_arms } : {}),
        ...(space === "rrf" && s.score_version ? { score_version: s.score_version } : {}),
      };
      const existing = fused.get(h.id);
      if (!existing) {
        fused.set(h.id, { hit: tagged, rank, rrf: contribution });
        return;
      }
      existing.rrf += contribution;
      if (rank < existing.rank) {
        existing.hit = tagged;
        existing.rank = rank;
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, k)
    .map((e) => e.hit);
}
