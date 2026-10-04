/**
 * Die beiden Schritte von `recallHybrid` (search.ts), die nur auf dem
 * Hybrid-Pfad laufen (#1039): das Warten auf den dichten Arm samt Vault-Filter
 * (`awaitDenseArm`) und die RRF-Fusion zum Kandidatenpool (`fuseArms`).
 * Abfeuern, Cache, BM25 und Ranking bleiben in `recallHybrid` — die
 * Reihenfolge der Arme (#370/#305/#466) ist dort beschrieben und unverändert.
 */
import type { Memory } from "./schema.js";
import type { Vault } from "./vault.js";
import type { EmbeddingHit, VectorSearchOutcome } from "./embeddings.js";
import { fuseRRF, RRF_SCALE } from "./embeddings.js";
import { abandonAfter } from "./deadline.js";
import { scopeEquals } from "./scope.js";
import type { DocFreqMiniSearch } from "./doc-freq-index.js";
import type { IndexDoc, RecallHit, RecallOptions } from "./search-types.js";
import { matchedRecallWhen, anchorStrength } from "./search-anchor.js";
import { round, type StageEmitter } from "./search-pipeline.js";

/** Ein Treffer des dichten Arms, mit seinem Memory aus dem Vault. */
export interface DenseArmHit {
  hit: EmbeddingHit;
  mem: Memory | undefined;
}

/**
 * Wartet auf den bereits abgefeuerten dichten Arm (Frist ab hier, #466),
 * filtert seine Treffer gegen den Vault und schließt die Stage
 * `vector.search`, die `recallHybrid` beim Abfeuern (`tVec`) geöffnet hat.
 */
export async function awaitDenseArm(
  vectorArm: Promise<VectorSearchOutcome>,
  vault: Vault,
  opts: RecallOptions,
  stage: StageEmitter,
  tVec: number,
): Promise<{ vectorTop: DenseArmHit[]; vectorArmTimedOut: boolean; vectorArmErrored: boolean }> {
  // #342: race the dense arm against its own deadline. `abandonAfter` never
  // rejects and never cancels — on expiry it hands back null and leaves the
  // embed in flight, which is the point: the model finishes loading on the
  // call that gave up on it, so the NEXT call is warm. Cancelling here would
  // re-pay the cold load every single time.
  // #466: Der Timer startet HIER, beim echten Warten (siehe oben).
  // #489: Die Wanduhr des Aufrufers. `vector.search` misst ab dem Abfeuern und
  // überlappt damit BM25 — gemessen 06.–08.09. ist dieser Überlapp in der
  // Prompt-Lane praktisch alles: vector p50 336 ms gegen bm25 p50 329 ms, echte
  // Wartezeit 5 ms. Wer die alte Zahl als Wartezeit las, sah 82,6 % gerissene
  // Deadlines, wo in Wahrheit 14 von 323 Aufrufen ihre Frist rissen. Ab hier
  // gibt es beide Größen nebeneinander: die alte Spanne unverändert (die Serie
  // läuft seit Wochen), die Wartezeit als eigenes Feld.
  const tVecWait = Date.now();
  const vecOrTimeout = await abandonAfter(
    vectorArm,
    opts.vector_deadline_ms ?? 0,
    opts.onVectorLateSettle,
    // #493: Der späte Arm meldet sein ERGEBNIS mit, nicht nur seine Laufzeit
    // — ohne das kann Kriterium 4 aus #492 die kontrafaktische Fusionsrate
    // nicht rechnen (ein Arm, der spät mit `empty` settelt, hätte auch mit
    // längerer Frist nichts fusioniert).
    (r) => ({
      outcome: r.outcome,
      hit_count: r.hits.length,
      provider_load_ms: r.providerLoadMs,
      cold_start_observed: r.coldStartObserved,
    }),
  );
  const vectorWaitMs = Date.now() - tVecWait;
  const vectorArmTimedOut = vecOrTimeout === null;
  // #493: der Ausgang, wie der Provider ihn berichtet — nicht mehr aus einem
  // Fehlerzähler-Delta erschlossen. Beim Timeout ist der Arm noch in Flug und
  // hat noch gar keinen Ausgang; die späte Stichprobe trägt ihn nach.
  const vectorArmErrored = vecOrTimeout?.outcome === "error";
  const vec = vecOrTimeout?.hits ?? [];
  const vectorTop = vec
    .map((h) => ({ hit: h, mem: vault.get(h.id) }))
    .filter(({ mem }) => {
      if (!mem) return false;
      if (mem.fm.obsolete === true) return false;
      if (opts.scope && !scopeEquals(mem.fm.scope, opts.scope)) return false;
      if (opts.type && mem.fm.type !== opts.type) return false;
      if (
        !opts.allow_private &&
        (mem.fm as { sensitivity?: string }).sensitivity === "private"
      ) {
        return false;
      }
      return true;
    })
    .slice(0, 50);
  // #370: die Spanne deckt dispatch→settle und ÜBERLAPPT `bm25.search`.
  // `overlapped` sagt jedem Leser dieser Telemetrie, dass die Stages keine
  // Partition des Totals mehr sind — genau die Residuum-Rechnung, mit der
  // die Sequentialität nachgewiesen wurde, gilt danach nicht mehr.
  // #489: `wait_ms` reitet auf derselben Stage mit, statt eine neue
  // aufzumachen — die Stage-Namen sind eine geschlossene Union, an der
  // Banter-Phrasen und Fortschrittsindex hängen, und eine zweite Stage für
  // dieselbe Sache hätte den Fortschrittsbalken verlängert, ohne dass ein
  // Schritt dazugekommen wäre. `durationMs` bleibt exakt die alte Spanne.
  stage.end("vector.search", tVec, {
    vector_hit_count: vectorTop.length,
    overlapped: true,
    wait_ms: vectorWaitMs,
    // Ohne dieses Bit ist eine Wartezeit auf der Deadline nicht von einem Arm
    // zu unterscheiden, der zufällig genau dort fertig wurde.
    timed_out: vectorArmTimedOut,
    // #493: der strukturierte Ausgang, für den Schatten in
    // `http-hook-routes.ts`. `provider_hit_count` sind die ROHEN Treffer des
    // Providers vor dem Vault-Filter — `vector_hit_count` darüber bleibt die
    // gefilterte Zahl, die diese Stage seit jeher meldet, damit keine
    // laufende Auswertung ihre Bedeutung wechselt.
    ...(vecOrTimeout
      ? {
          provider_outcome: vecOrTimeout.outcome,
          provider_hit_count: vecOrTimeout.hits.length,
          provider_load_ms: vecOrTimeout.providerLoadMs,
          cold_start_observed: vecOrTimeout.coldStartObserved,
        }
      : {}),
  });
  return { vectorTop, vectorArmTimedOut, vectorArmErrored };
}

/**
 * RRF über beide Arme und Hit-Konstruktion für den tiefen Pool
 * (max(k*4, 20), Hop-Seeds) — mit ROHEN Scores; Dämpfung und Top-k-Schnitt
 * macht `recallHybrid` danach.
 */
export function fuseArms(
  bm25Top: ReturnType<DocFreqMiniSearch<IndexDoc>["search"]>,
  vectorTop: DenseArmHit[],
  k: number,
  vault: Vault,
  authoredTerms: ReadonlySet<string>,
  recallWhenDocFreq: (term: string) => number,
  stage: StageEmitter,
): RecallHit[] {
  const tFuse = stage.start("rrf.fuse");
  const bm25Ids = bm25Top.map((r) => r.id as string);
  const vectorIds = vectorTop.map(({ hit }) => hit.id);
  const fused = fuseRRF(bm25Ids, vectorIds);

  // Lookup-Maps für die finale Hit-Konstruktion.
  const bm25Lookup = new Map(bm25Top.map((r) => [r.id as string, r]));
  const vectorLookup = new Map(vectorTop.map((v) => [v.hit.id, v]));

  const sorted = Array.from(fused.entries()).sort((a, b) => b[1].score - a[1].score);
  // Größerer Pool für Hop-Seeds (siehe recall()-Kommentar).
  const HOP_SEED_POOL = Math.max(k * 4, 20);
  const outFull: RecallHit[] = [];
  for (const [id, entry] of sorted) {
    if (outFull.length >= HOP_SEED_POOL) break;
    const bm = bm25Lookup.get(id);
    const v = vectorLookup.get(id);
    const mem = v?.mem ?? vault.get(id);
    if (!mem) continue;
    const fm = mem.fm;
    const inBoth = bm !== undefined && v !== undefined;
    outFull.push({
      id: fm.id,
      title: fm.title,
      type: fm.type,
      scope: fm.scope,
      summary: fm.summary,
      topic_path: fm.topic_path,
      // RRF-Score skaliert auf BM25-vergleichbare Range. Der Faktor hängt an
      // RRF_K (embeddings.ts), damit die Anker 163.934 / 81.967 stehen
      // bleiben, wenn sich die Fusion ändert.
      score: round(entry.score * RRF_SCALE),
      matched_terms: bm?.terms ?? [],
      // #148: vom BM25-Arm; ein reiner Vektor-Treffer (kein `bm`) ist kein
      // lexikalisches recall_when-Match → false.
      matched_recall_when: bm ? matchedRecallWhen(bm, authoredTerms) : false,
      ...(() => {
        const a = bm
          ? anchorStrength(bm, authoredTerms, (t) => recallWhenDocFreq(t), (id) =>
              vault.get(id)?.fm.recall_when ?? [],
            )
          : undefined;
        return a ? { anchor_strength: a } : {};
      })(),
      mode: inBoth ? "hybrid" : bm ? "bm25" : "vector",
      hop: "direct" as const,
      // #230: Rang-Herkunft des skalierten Scores durchreichen (nur Hybrid).
      rrf: { rank_bm25: entry.rank_bm25, rank_vector: entry.rank_vector, raw: entry.score },
    });
  }
  stage.end("rrf.fuse", tFuse, { fused_count: outFull.length });
  return outFull;
}
