/**
 * Was `recall()` und `recallHybrid()` pro Aufruf gemeinsam brauchen (#1039):
 * der Treffer-Filter, die Score-Rundung, die Stage-Events, der Query-Cache
 * und die 1-Hop-Expansion. Der Zustand selbst (Query-Cache-Map, Vault) bleibt
 * in `SearchIndex` (search.ts) und wird hier als Argument übergeben.
 */
import type { Vault } from "./vault.js";
import type { RecallStage, StageListener } from "./recall-stages.js";
import { scopeEquals } from "./scope.js";
import type { RecallHit, RecallOptions } from "./search-types.js";

/**
 * Standard-Filter für BM25-Roh-Treffer: obsolete-Maskierung, scope/type-
 * Exact-Match (scope gefaltet über `scopeEquals`, #360-Folgefund — ein aus
 * dem Dateisystem erkannter Projektname trägt eine andere Schreibweise als
 * der im Vault gespeicherte Scope), und der neue Sensitivity-Filter (#58). Wird sowohl von
 * `recall` als auch von `recallHybrid` aufgerufen, damit der Filter an
 * einer Stelle gepflegt wird. `r` ist ein MiniSearch-`SearchResult`, das
 * via `storeFields` die gespeicherten Doc-Properties als beliebige
 * Keys mit-trägt — daher das `Record<string, unknown>`-Typing hier.
 */
export function passesRecallFilters(
  r: Record<string, unknown>,
  opts: RecallOptions,
): boolean {
  if (r.obsolete) return false;
  if (opts.scope && !scopeEquals(r.scope as string, opts.scope)) return false;
  if (opts.type && r.type !== opts.type) return false;
  if (!opts.allow_private && r.sensitivity === "private") return false;
  return true;
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// MARK: - Stage-Event-Emitter (#38)

/**
 * Hilfsklasse für Stage-Events in `recall` / `recallHybrid`. Hält den
 * optionalen Listener und liefert `start()`/`end()`/`emit()`. Bei
 * fehlendem Listener sind alle Methoden no-op und allokationsfrei
 * (kein `Date.now()` ohne Bedarf). Die Klasse ist nicht öffentlich,
 * weil sie tight an die Stage-Sequenz gekoppelt ist — die public Types
 * stehen in `recall-stages.ts`.
 */
export class StageEmitter {
  constructor(private readonly listener?: StageListener) {}

  /** Start-Event feuern. Liefert den Start-Timestamp, der unverändert
   *  an `end()` zurückgegeben wird (so muss der Caller kein lokales
   *  `const t = Date.now()` aufmachen). */
  start(name: RecallStage["name"], meta?: Record<string, unknown>): number {
    if (!this.listener) return 0;
    const t = Date.now();
    this.listener({ name, startedAtMs: t, meta });
    return t;
  }

  /** Stop-Event feuern. `startedAt` ist der Rückgabewert von `start()`. */
  end(name: RecallStage["name"], startedAt: number, meta?: Record<string, unknown>): void {
    if (!this.listener) return;
    const dur = Date.now() - startedAt;
    this.listener({ name, startedAtMs: startedAt, durationMs: dur, meta });
  }

  /** One-shot-Event (kein separates Stop) — für `cache.hit`, `done`,
   *  `error`. `startedAtMs` ist der „Recall-Start" (für `done`) oder
   *  der Event-Zeitpunkt selbst. */
  emit(name: RecallStage["name"], startedAtMs: number, meta?: Record<string, unknown>): void {
    if (!this.listener) return;
    this.listener({ name, startedAtMs, durationMs: Date.now() - startedAtMs, meta });
  }
}

// MARK: - Query-Cache (#30)

/** Ein Eintrag im Query-Cache von `SearchIndex` — siehe dort für Größe und TTL. */
export interface QueryCacheEntry {
  hits: RecallHit[];
  pool: RecallHit[];
  at: number;
  degraded?: string;
}

const QUERY_CACHE_MAX = 100;
const QUERY_CACHE_TTL_MS = 30_000;

/**
 * LRU-Lookup für `queryCache` (#30). Bei Hit wird der Eintrag
 * re-inserted, damit die Map-insertion-order ihn als „recently used"
 * sieht. TTL 30s — frische Edits sollen den Cache nicht zu lange
 * dominieren, auch wenn der Watcher nicht feuert.
 */
export function lookupQueryCache(
  queryCache: Map<string, QueryCacheEntry>,
  key: string,
): { hits: RecallHit[]; pool: RecallHit[]; degraded?: string } | undefined {
  const cached = queryCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.at > QUERY_CACHE_TTL_MS) {
    queryCache.delete(key);
    return undefined;
  }
  // LRU-Bump: löschen + neu setzen, damit Map-iteration den Eintrag
  // als jüngsten sieht.
  queryCache.delete(key);
  queryCache.set(key, cached);
  // Defensive Kopie — Caller könnte das Array mutieren (sortieren,
  // pushen). Cache-Werte bleiben damit stabil über Calls hinweg.
  // #365/5: `pool` ist bewusst die CACHE-INTERNE Referenz und darf so nie
  // nach außen — der defensive Klon liegt in `emitCachedPool()`, damit ein
  // Cache-Hit ohne `onCandidatePool` keine einzige Allokation mehr kostet
  // als vor #365 (Hook-Budget #305/#362).
  // P0: `degraded` muss mit raus. Der Score-RAUM (rohes BM25 vs. RRF) ist
  // eine Eigenschaft des gecachten Ergebnisses, nicht des Calls, der es
  // ausliefert — ohne dieses Feld nannte der Handler dieselben Zahlen beim
  // zweiten Aufruf `rrf` und legte die Bänder 50/100 an eine offene Skala.
  return { hits: cached.hits.map((h) => ({ ...h })), pool: cached.pool, degraded: cached.degraded };
}

/** #365/5: den mitgecachten tiefen Pool bei einem Query-Cache-Hit
 *  nachliefern. Defensiver Klon nur hier, und nur wenn jemand zuhört. */
export function emitCachedPool(opts: RecallOptions, pool: RecallHit[]): void {
  if (!opts.onCandidatePool) return;
  opts.onCandidatePool(pool.map((h) => ({ ...h })));
}

export function storeQueryCache(
  queryCache: Map<string, QueryCacheEntry>,
  key: string,
  hits: RecallHit[],
  pool: RecallHit[],
  degraded?: string,
): void {
  if (queryCache.size >= QUERY_CACHE_MAX) {
    // Oldest first — Map preserved insertion order.
    const oldest = queryCache.keys().next().value;
    if (oldest !== undefined) queryCache.delete(oldest);
  }
  // Kopie der Hit-Objekte, gleicher Grund wie in lookupQueryCache. Bewusst
  // FLACH: `topic_path`, `matched_terms` und `rrf` bleiben mit dem Original
  // geteilt. Das reicht, weil die Pipeline nur `score` schreibt (in
  // applyStaleness) und Consumer die Arrays lesen; ein tiefer Klon wäre auf
  // dem Hook-Pfad reiner Overhead.
  queryCache.set(key, {
    hits: hits.map((h) => ({ ...h })),
    pool: pool.map((h) => ({ ...h })),
    at: Date.now(),
    ...(degraded ? { degraded } : {}),
  });
}

// MARK: - Multi-Hop (#30 / #51)

/**
 * Multi-Hop-Expansion (#30 / #51): sammelt `related_via.id`-Nachbarn aus
 * den Seed-Hits (typischerweise top-20 aus dem BM25/Hybrid-Pool, nicht nur
 * top-k — sonst gehen Nachbarn von Position 6–20 verloren), filtert sie
 * (obsolete / scope / type / sensitivity / dedup gegen `exclude`), und
 * liefert sie mit reduziertem Score sortiert zurück. Score-Reduktion:
 * `seed.score * 0.5 * link.score` (heuristisch — Nachbarn sollen nie über
 * direkte Treffer ranken). Wenn ein Nachbar mehrfach gefunden wird, gewinnt
 * der höchste Score.
 */
export function collectOneHopNeighbors(
  vault: Vault,
  seeds: RecallHit[],
  opts: RecallOptions,
  exclude: Set<string>,
): RecallHit[] {
  if (seeds.length === 0) return [];
  const best = new Map<string, RecallHit>();
  for (const seed of seeds) {
    const mem = vault.get(seed.id);
    const related = (mem?.fm as { related_via?: { id: string; reason: string; score: number }[] })
      ?.related_via;
    if (!related?.length) continue;
    for (const link of related) {
      if (exclude.has(link.id)) continue;
      const neigh = vault.get(link.id);
      if (!neigh) continue;
      if (neigh.fm.obsolete === true) continue;
      if (opts.scope && !scopeEquals(neigh.fm.scope, opts.scope)) continue;
      if (opts.type && neigh.fm.type !== opts.type) continue;
      if (
        !opts.allow_private &&
        (neigh.fm as { sensitivity?: string }).sensitivity === "private"
      ) {
        continue;
      }
      const score = round(seed.score * 0.5 * link.score);
      const prior = best.get(link.id);
      if (prior && prior.score >= score) continue;
      best.set(link.id, {
        id: neigh.fm.id,
        title: neigh.fm.title,
        type: neigh.fm.type,
        scope: neigh.fm.scope,
        summary: neigh.fm.summary,
        topic_path: neigh.fm.topic_path,
        score,
        matched_terms: [],
        mode: seed.mode,
        hop: "1-hop" as const,
      });
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score);
}
