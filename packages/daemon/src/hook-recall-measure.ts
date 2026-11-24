/**
 * Measurement and telemetry of one hook recall (split out of
 * `runHookRecall`, #1513): the stage timings collected from the search's
 * stage events, the event-loop probe around the recall, and the projection of
 * everything measured into the `hook_recall` row. The search orchestration
 * stays in `http-hook-routes.ts`; nothing here decides what is served.
 */
import type { RecallHit, RecallStage, QueryRoute, routeRetrieval } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import type { TelemetryPoolCandidate } from "./training-signal.js";
import type { VectorArmReport } from "./deadline-shadow-row.js";
import type { expandQuery } from "./learned-recall/bridges.js";
import type { applyCallerScopeFilter } from "./recall-pipeline.js";
import type { effectiveHintSuppressionMode, suppressRepeatedUnused } from "./hint-suppression.js";
import type { measurePayload } from "./recall-budget.js";
import { computeSalienceShadow } from "./salience-shadow.js";
import { computeTrustShadow, trustRankMode, usageForShadow } from "./trust-shadow.js";
import { armsOf, currentScoreVersion } from "./score-space.js";
import { dimensionHints } from "./telemetry-dimensions.js";
import type { Vault } from "@bastra-recall/core";
import type { readHookRecallInput } from "./hook-recall-input.js";

type HookRecallRow = Parameters<Telemetry["logHookRecall"]>[0];
export type StageTimings = NonNullable<HookRecallRow["recall_stages"]>;

const STAGE_DURATION_FIELD: Readonly<Record<string, keyof StageTimings>> = {
  "query.parse": "query_parse_ms",
  "bm25.search": "bm25_search_ms",
  "vector.search": "vector_search_ms",
  "rrf.fuse": "rrf_fuse_ms",
  "hops.expand": "hops_expand_ms",
  "staleness.rank": "staleness_rank_ms",
};

/** What the stage events of one recall said, collected as they arrive. */
export interface StageCollector {
  timings: StageTimings;
  collect: (s: RecallStage) => void;
  /** #342: why the hit list came back one-armed, if it did. */
  degradedReason: () => string | undefined;
  /** #493: what the dense arm reported about itself; null while it runs. */
  armReport: () => VectorArmReport | null;
}

export function createStageCollector(): StageCollector {
  const timings: StageTimings = {};
  // #342: Recorded rather than merely returned — #305's whole finding is that
  // this lane fails quietly, and a degradation nobody counts repeats that
  // failure one level up: recall gets worse and the only visible symptom is
  // that it got faster. `vector-arm-timeout` is the deadline firing,
  // `vector-arm-empty` the pre-existing case where the arm had nothing to say.
  let degradedReason: string | undefined;
  // #493: `null`, solange der Arm noch läuft (Timeout) — dann trägt die späte
  // Stichprobe den Ausgang nach.
  let armReport: VectorArmReport | null = null;
  const collect = (s: RecallStage): void => {
    if (s.name === "done" && typeof s.meta?.degraded === "string") degradedReason = s.meta.degraded;
    if (s.name === "bm25.search") collectQueryCost(timings, s);
    if (s.name === "cache.hit") {
      timings.cache_hit = true;
      return;
    }
    if (s.name === "vector.search") armReport = collectVectorMeta(timings, s) ?? armReport;
    if (s.durationMs === undefined) return;
    const field = STAGE_DURATION_FIELD[s.name];
    if (field) (timings as Record<string, unknown>)[field] = s.durationMs;
  };
  return { timings, collect, degradedReason: () => degradedReason, armReport: () => armReport };
}

/** #362 Phase 0: Die Querykosten reiten auf der bm25-Stage mit — sie sagen,
 *  ob ein langsamer Aufruf viele Terme hatte oder viele Wiederholungen, und
 *  das entscheidet, welcher Hebel überhaupt greift. */
function collectQueryCost(timings: StageTimings, s: RecallStage): void {
  const emitted = s.meta?.terms_emitted;
  const unique = s.meta?.terms_unique;
  if (typeof emitted === "number") timings.terms_emitted = emitted;
  if (typeof unique === "number") timings.terms_unique = unique;
}

/**
 * #489: Die Wartezeit reitet auf der vector-Stage mit — `durationMs` bleibt
 * die alte, überlappende Spanne, `wait_ms` ist das, was der Aufrufer wirklich
 * gewartet hat. Beide Zahlen nebeneinander sind der ganze Punkt: Ohne sie las
 * die Prompt-Lane 82,6 % gerissene Deadlines, wo 14 von 323 Aufrufen ihre
 * Frist rissen.
 * #493: Der strukturierte Ausgang des Arms reitet auf derselben Stage mit. Er
 * entscheidet, ob dieser Aufruf überhaupt eine Latenzstichprobe ist: Ein
 * Providerfehler kam vorher als aufgelöste Promise zurück und wurde als
 * gültige Dauer gelernt.
 */
function collectVectorMeta(timings: StageTimings, s: RecallStage): VectorArmReport | null {
  const meta = s.meta;
  if (typeof meta?.wait_ms === "number") timings.vector_wait_ms = meta.wait_ms;
  if (typeof meta?.provider_outcome !== "string") return null;
  return {
    outcome: meta.provider_outcome as VectorArmReport["outcome"],
    hit_count: typeof meta.provider_hit_count === "number" ? meta.provider_hit_count : 0,
    provider_load_ms: typeof meta.provider_load_ms === "number" ? meta.provider_load_ms : null,
    cold_start_observed: meta.cold_start_observed === true,
  };
}

/**
 * #362 Phase 0: Wie lange blockiert der synchrone lexikalische Arm den Event
 * Loop? Ein Timer, der alle 10 ms feuern SOLL, aber erst nach 400 ms
 * drankommt, hat 390 ms Blockade gemessen — ohne Instrumentierung im Suchcode
 * selbst, und ohne perf_hooks-Histogramm, das über den ganzen Prozess mittelt
 * statt diesen einen Aufruf zu beschreiben.
 *
 * Die Zahl ist die Vorbedingung dafür, einen Worker später überhaupt bewerten
 * zu können: Er macht die Rechnung nicht schneller, er gibt nur den Loop frei.
 * Ohne Vorher-Wert ist der Nachher-Wert bedeutungslos.
 * ACHTUNG, gemessene Grenze dieser Sonde: Sie sieht nur Blockaden, die ein
 * `await` überspannen. Auf einer Maschine OHNE Embeddings läuft
 * `search.recall()` durchgehend synchron — der Timer bekommt bis zum
 * `clearInterval` nie eine Gelegenheit zu feuern und meldet 0, obwohl der
 * Loop die ganze Zeit stand. Für diesen Fall ist `bm25_search_ms` der
 * ehrlichere Blockade-Wert, und genau so wird er in {@link eventLoopFields}
 * auch verwendet.
 */
const LOOP_PROBE_EVERY_MS = 10;

export interface LoopProbeResult {
  ticks: number;
  blockMs: number;
}

export function startLoopProbe(): { stop: () => LoopProbeResult } {
  let ticks = 0;
  let blockMs = 0;
  let lastTick = Date.now();
  const timer = setInterval(() => {
    ticks++;
    const now = Date.now();
    const lag = now - lastTick - LOOP_PROBE_EVERY_MS;
    if (lag > blockMs) blockMs = lag;
    lastTick = now;
  }, LOOP_PROBE_EVERY_MS);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      return { ticks, blockMs };
    },
  };
}

/**
 * #362 Phase 0: nur melden, wenn überhaupt spürbar blockiert wurde — eine 0
 * in jedem Event wäre Rauschen, das die Auswertung verwässert. Hat die Sonde
 * überhaupt getickt? Wenn nicht, lief alles synchron und die Blockade ist die
 * Rechenzeit selbst — sonst stünde hier eine 0, die wie „kein Problem"
 * aussieht und genau den Fall verschweigt, für den die Zahl gedacht war.
 */
function eventLoopFields(
  probe: LoopProbeResult,
  bm25SearchMs: number | undefined,
  recallLatencyMs: number
): { event_loop_block_ms: number; event_loop_block_source: "sync-fallback" | "probe" } | Record<string, never> {
  if (probe.ticks === 0)
    return { event_loop_block_ms: bm25SearchMs ?? recallLatencyMs, event_loop_block_source: "sync-fallback" };
  if (probe.blockMs >= LOOP_PROBE_EVERY_MS)
    return { event_loop_block_ms: probe.blockMs, event_loop_block_source: "probe" };
  return {};
}

/** Everything one hook recall measured, for its telemetry row. */
export interface HookRecallMeasurement extends Pick<
  ReturnType<typeof readHookRecallInput>,
  "hookSessionId" | "sessionStartCallId" | "hookToolName" | "hookProject" | "k" | "scope" | "type" | "maxTokens"
> {
  body: Record<string, unknown>;
  query: string;
  recallId: string;
  vault: Vault;
  hits: RecallHit[];
  usageSuppression: ReturnType<typeof suppressRepeatedUnused>;
  suppressionMode: ReturnType<typeof effectiveHintSuppressionMode>;
  recallLatencyMs: number;
  totalLatencyMs: number;
  stages: StageCollector;
  probe: LoopProbeResult;
  deadlineShadowRow: HookRecallRow["deadline_shadow"];
  queryRoute: QueryRoute | null;
  routerMode: string;
  routedLexical: boolean;
  shadowRoute: ReturnType<typeof routeRetrieval> | undefined;
  expansion: ReturnType<typeof expandQuery>;
  callerScopeFilter: ReturnType<typeof applyCallerScopeFilter> | null;
  candidatePool: TelemetryPoolCandidate[];
  hybridActiveAtRecall: boolean;
  contentRecall: HookRecallRow["content_recall"];
  embeddingDegradedAtRecall: boolean;
  lexicalOnly: boolean;
  weakResult: boolean;
  noHome: boolean;
  budgetSize: ReturnType<typeof measurePayload> | null;
  budgetDropped: number;
}

/** The `hook_recall` row: what the recall served, how long each part took
 *  and every shadow measurement taken along the way. */
export function hookRecallRow(m: HookRecallMeasurement): HookRecallRow {
  const { hits, stages } = m;
  return {
    ...identityFields(m),
    tool_name: m.hookToolName,
    project: m.hookProject,
    k: m.k,
    scope: m.scope ?? null,
    type: m.type ?? null,
    vault_size: m.vault.size(),
    hit_count: hits.length,
    top_score: hits[0]?.score ?? null,
    hits: hits.map((h) => ({
      id: h.id,
      score: h.score,
      type: h.type,
      // #263: die Hop-Herkunft, die §18.2 fürs M1-Gate braucht.
      ...(h.hop ? { hop: h.hop } : {}),
    })),
    ...suppressionFields(m),
    latency_ms_recall: m.recallLatencyMs,
    latency_ms_total: m.totalLatencyMs,
    recall_stages: stages.timings,
    // #491: Prognose neben der Zahl, die tatsächlich galt. Reiner
    // Schatten — an dieser Antwort hat sie nichts geändert.
    deadline_shadow: m.deadlineShadowRow,
    ...eventLoopFields(m.probe, stages.timings.bm25_search_ms, m.recallLatencyMs),
    ...routerFields(m),
    bridge_expansion:
      m.expansion.lang && m.expansion.added.length > 0
        ? { lang: m.expansion.lang, added: m.expansion.added, applied: m.expansion.applied }
        : undefined,
    // #421: nur auf Aufrufen mit `apply_scope_filter` (MCP) — Hook-Zeilen
    // behalten ihre Felder unverändert.
    ...(m.callerScopeFilter ? m.callerScopeFilter.telemetry : {}),
    candidate_pool: m.candidatePool.length > 0 ? m.candidatePool : undefined,
    ...scoreSpaceFields(m.hybridActiveAtRecall, m.candidatePool.length > 0),
    content_recall: m.contentRecall,
    // #165: pre-recall festgehalten, siehe recallHandler.
    embedding_degraded: m.embeddingDegradedAtRecall ? true : undefined,
    // #342: which arm dropped out, if one did.
    degraded_reason: stages.degradedReason(),
    // #494: Dieser Recall hat den dichten Arm ABGEWÄHLT. Ohne die Spalte
    // wäre er von einem Recall auf einer Maschine ohne Embeddings nicht
    // zu unterscheiden — und die Auswertung zu #492 würde einen
    // Kaltstart zählen, der nie gemessen wurde.
    lexical_only: m.lexicalOnly ? true : undefined,
    // #217: would-be Salience-Reihenfolge (shadow-only).
    salience_shadow: computeSalienceShadow(hits, (id) => m.vault.get(id)?.fm as Record<string, unknown> | undefined),
    // #160: dieselbe Projektion für den Trust-Multiplikator. MUSS hier
    // stehen und nicht nur im MCP-Pfad: der Hook ist der häufigere
    // Aufrufer, und ein Shadow, der nur die Tool-Calls sieht, misst eine
    // Verteilung, die es so nicht gibt.
    trust_shadow:
      trustRankMode() === "shadow" ? computeTrustShadow(hits, (id) => usageForShadow(m.vault.root)[id]) : undefined,
    // #249: recorded, not just returned. Without this the flag reads
    // zero in every stats run — not because recall is healthy, but
    // because nothing ever wrote it down.
    weak_result: m.weakResult || undefined,
    no_home: m.noHome || undefined,
    ...budgetFields(m),
  };
}

/** Which recall this is, for whom, from which surface. */
function identityFields(m: HookRecallMeasurement) {
  const { body } = m;
  return {
    recall_id: m.recallId,
    query: m.query,
    // #363: die Claude-Session-id aus dem Hook-Payload ins Event — ohne sie
    // stempelt der Sink seine Boot-UUID und keine Auswertung auf Recall-Ebene
    // kann nach Session oder Turn gruppieren. Gleiche Form wie
    // logHookAct/logHookReflex: fehlt sie, bleibt die Boot-UUID.
    ...(m.hookSessionId ? { session_id: m.hookSessionId } : {}),
    // #493: Die Klammer um die Recalls EINES Sitzungsstarts. Ohne sie ist
    // „20 Kaltstarts" (Tor 3 aus #492) nicht von „7 Kaltstarts × 3
    // Recalls" zu unterscheiden.
    ...(m.sessionStartCallId ? { session_start_call_id: m.sessionStartCallId } : {}),
    // #263: Oberflächen-Hinweise. `hook_source` trennt die Lanes
    // voneinander UND vom MCP-Forwarder, der `recall` über denselben
    // Endpunkt proxyt — ohne die Spalte wären beide dasselbe Ereignis.
    ...dimensionHints(body),
    // #351: batch width when this recall is one phrasing of a batch.
    query_count: typeof body.batch_of === "number" ? body.batch_of : undefined,
    topics: Array.isArray(body.topics)
      ? (body.topics as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
  };
}

/** #479/#484: what the usage breaker removed or would have removed. Without
 *  the mode a report cannot tell the live history (up to 2026-09-06) from
 *  the shadow counts after it — both write the same `usage_suppressed` list,
 *  only one of them acted on it. */
function suppressionFields(m: HookRecallMeasurement) {
  const suppressed = m.usageSuppression.suppressed;
  if (suppressed.length === 0)
    return { usage_suppressed: undefined, usage_suppressed_tokens_est: undefined, usage_suppressed_mode: undefined };
  return {
    usage_suppressed: suppressed,
    usage_suppressed_tokens_est: suppressed.reduce((n, s) => n + s.tokens_est, 0),
    usage_suppressed_mode: m.suppressionMode !== "off" ? m.suppressionMode : undefined,
  };
}

/**
 * #362: die Messuhr des Query-Routers. Nur wo er eingegriffen hätte (bzw.
 * hat) — eine `hybrid`-Zeile auf jedem Recall wäre Rauschen; der Nenner ist
 * die Zahl der hook_recall-Zeilen. `would_save_ms` ist die Wartezeit auf den
 * dichten Arm NACH BM25 (#489) — genau das, was ein BM25-only-Lauf diesem
 * Aufrufer erspart hätte. Daneben die Schatten-Route (#362 Phase 2).
 */
function routerFields(m: HookRecallMeasurement) {
  const { queryRoute, shadowRoute, stages } = m;
  return {
    ...(queryRoute && queryRoute.arms === "bm25"
      ? {
          query_route: {
            arms: "bm25" as const,
            // `arms: "bm25"` kommt nur mit `short` oder `identifier`.
            reason: queryRoute.reason as "short" | "identifier",
            unique_terms: queryRoute.unique_terms,
            identifier_terms: queryRoute.identifier_terms,
            mode: m.routerMode as "shadow" | "live",
            applied: m.routedLexical,
            ...(!m.routedLexical && stages.timings.vector_wait_ms !== undefined
              ? { would_save_ms: stages.timings.vector_wait_ms }
              : {}),
          },
        }
      : {}),
    ...(shadowRoute
      ? {
          shadow_route: {
            mode: shadowRoute.mode,
            estimated_lexical_ms: Math.round(shadowRoute.estimatedLexicalMs),
            lexical_fits: shadowRoute.lexicalFits,
            unique_terms: stages.timings.terms_unique as number,
          },
        }
      : {}),
  };
}

/**
 * Zweiter Gegenreview: derselbe explizite Raum wie auf dem Response.
 * `top_score` und `candidate_pool` sind sonst Zahlen ohne Skala, und eine
 * Auswertung, die sie über degradierte und fusionierte Recalls hinweg
 * mittelt, misst zwei verschiedene Größen als eine.
 * Codex-Gegenreview (P1): Der Pool braucht dieselbe volle Signatur wie der
 * Haupt-Score: Kind + Version + Armmenge. Version NUR auf der fusionierten
 * Skala — auf rohem BM25 gibt es keine Formel zu versionieren.
 */
function scoreSpaceFields(hybrid: boolean, hasPool: boolean) {
  const kind = hybrid ? ("rrf" as const) : ("bm25" as const);
  return {
    score_kind: kind,
    score_arms: armsOf({ hybridActive: hybrid, commonsFused: false }),
    score_version: hybrid ? currentScoreVersion() : undefined,
    candidate_pool_score_kind: hasPool ? kind : undefined,
    candidate_pool_score_arms: hasPool ? armsOf({ hybridActive: hybrid, commonsFused: false }) : undefined,
    candidate_pool_score_version: hasPool && hybrid ? currentScoreVersion() : undefined,
  };
}

/** #487: angefordertes Budget gegen ausgeliefertes Payload — erst beide
 *  Zahlen zusammen ordnen die Ersparnis jemandem zu (#457). */
function budgetFields(m: HookRecallMeasurement) {
  if (!m.budgetSize) return {};
  return {
    max_tokens: m.maxTokens,
    dropped_by_budget: m.budgetDropped > 0 ? m.budgetDropped : undefined,
    payload_chars: m.budgetSize.chars,
    payload_tokens_est: m.budgetSize.tokens,
  };
}
