import { readRulebookSources } from "./convention-source.js";
import { randomUUID } from "node:crypto";
import { markDraftDelivery } from "./draft-delivery.js";
import { cleanDraftField } from "./draft-text.js";
/**
 * Handler for the loopback-only /hook/recall endpoint (JSON + SSE).
 * Routing stays in http.ts; the handler logic lives here.
 * Split out of http.ts (file-size convention).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecallHit, Vault, SearchIndex, RecallStage, StageListener } from "@bastra-recall/core";
import { routeQueryArms, type QueryRoute } from "@bastra-recall/core";
import { fireAndForget, type Telemetry } from "./telemetry.js";
import { telemetryCandidatePool, type TelemetryPoolCandidate } from "./training-signal.js"; // #1128-capture
import { isOffValue } from "./env.js";
import { usageForShadow } from "./trust-shadow.js";
import { toLeanHit } from "./tool-handlers.js";
import { expandQuery, type BridgePool } from "./learned-recall/bridges.js";
import { type SupportedLanguage } from "./learned-recall/language.js";
import { isWeakResult, isNoHome, decideHits, pastValidUntil } from "@bastra-recall/core";
import { effectiveHintSuppressionMode, suppressRepeatedUnused } from "./hint-suppression.js";
import { applyCallerScopeFilter } from "./recall-pipeline.js";
import { type DeadlineShadow } from "./latency-profile.js";
import { MAX_BODY_BYTES, openSseHeaders, readJsonBody, sendJson, writeSseEvent } from "./http-util.js";
import { readHookRecallInput } from "./hook-recall-input.js";
import { runContentRecall } from "./hook-content-recall.js";
import { applyEvidenceGate } from "./hook-recall-evidence.js";
import { assembleHookRecallPayload, completeHookRecallPayload } from "./hook-recall-payload.js";
import { createStageCollector, hookRecallRow, startLoopProbe } from "./hook-recall-measure.js";
import { lateSettleRelay, lateSettleSink, shadowRouteFor, startDeadlineShadow } from "./hook-recall-shadow.js";

// ─── /hook/recall handler ────────────────────────────────────────

/**
 * #362: Der Query-Router (`routeQueryArms`, core) — seit v1.0.1 scharf.
 *
 * `live` (Default) lässt geroutete Anfragen ohne dichten Arm laufen (siehe
 * unten). `shadow` berechnet für jeden Recall mit dichtem Arm, ob er nur
 * den BM25-Arm bräuchte (kurze oder bezeichnerförmige Anfrage), und schreibt
 * das samt der Zeit, die es gespart hätte, als `query_route` an die
 * `hook_recall`-Zeile — geändert wird nichts. `live` lässt geroutete Anfragen
 * ohne dichten Arm laufen (ehrlich einarmig: `score_kind: "bm25"`, `unfused`,
 * kein `degraded`). `off` rechnet nichts.
 *
 * Warum `live` als Default: Gemessen auf Gold-Set-Lauf A
 * (`npm run router-lift`, eval) liegt keine Kennzahl unter der Baseline, und
 * geroutete Anfragen sinken von p50 14,8 auf 5,8 ms; der Owner hat am
 * 29.09.2026 für v1.0.1 scharf geschaltet. `shadow` bleibt als Rückweg. Pro
 * Aufruf gelesen wie die anderen Latenzschalter hier.
 */
export type QueryRouterMode = "off" | "shadow" | "live";
export function queryRouterMode(): QueryRouterMode {
  const v = process.env.BASTRA_QUERY_ROUTER;
  return isOffValue(v) ? "off" : v === "shadow" ? v : "live";
}

export function handleHookRecall(
  req: IncomingMessage,
  res: ServerResponse,
  t0: number,
  vault: Vault,
  search: SearchIndex,
  telemetry: Telemetry,
  learnedBridges?: BridgePool | null,
  sharedRecallLang?: SupportedLanguage | null,
  embeddingDegraded?: () => boolean,
  evidenceGateEnabled?: () => boolean,
  /** #491: das Latenzprofil im Schatten. Fehlt es, wird nichts gelernt und
   *  nichts protokolliert — die Antwort ist in beiden Fällen dieselbe. */
  deadlineShadow?: DeadlineShadow
): void {
  // SSE-Branch (#38): wenn der Caller `Accept: text/event-stream`
  // sendet, streamen wir Stages live. Default-JSON-Response bleibt
  // BC-erhalten — alte Hook-CLIs und REST-Caller sehen keinen
  // Unterschied.
  const accept = String(req.headers.accept ?? "");
  const wantsSse = accept.includes("text/event-stream");

  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      for (const field of ["session_id", "tool_name", "client", "agent_id"])
        if (typeof body[field] === "string")
          body[field] = cleanDraftField(body[field] as string, field === "tool_name" ? 80 : 200);
      // project and cwd are paths the recall itself reads: single-line, but
      // neither clipped nor stripped of the joiners a folder name may carry.
      for (const field of ["project", "cwd"])
        if (typeof body[field] === "string")
          body[field] = (body[field] as string).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "");
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) {
        if (wantsSse) {
          openSseHeaders(res);
          writeSseEvent(res, "error", { error: "query is required" });
          res.end();
        } else {
          sendJson(res, 400, { error: "query is required" });
        }
        return;
      }
      if (wantsSse) {
        openSseHeaders(res);
      }
      // #265: Die Pipeline steht jetzt als Funktion daneben; hier bleibt, was
      // HTTP ist — Body lesen, Eingabe prüfen, Stages streamen, antworten.
      const payload = await runHookRecall(
        body,
        query,
        t0,
        {
          vault,
          search,
          telemetry,
          learnedBridges,
          sharedRecallLang,
          embeddingDegraded,
          evidenceGateEnabled,
          deadlineShadow,
        },
        wantsSse
          ? (s: RecallStage) => {
              // Nur Stop- + cache.hit + done-Events streamen (Start-Events
              // wären für UI redundant). `done`-Event kommt unten als
              // separater finaler SSE-Event mit den hits[] — wir
              // unterdrücken den Stage-`done`, damit der finale Frame
              // nicht doppelt rendert.
              if (s.name === "done") return;
              if (s.durationMs === undefined && s.name !== "cache.hit") return;
              writeSseEvent(res, "stage", {
                name: s.name,
                durationMs: s.durationMs,
                meta: s.meta,
              });
            }
          : undefined
      );
      // #702: a replay marks no draft as delivered — the local draft store
      // keeps the state the live sessions gave it.
      if (!res.destroyed && !req.socket.destroyed && typeof body.session_id === "string" && body.client !== "replay")
        markDraftDelivery(
          cleanDraftField(body.session_id),
          Array.isArray(payload.draft_hits) ? payload.draft_hits.map((hit: { id: string }) => hit.id) : [],
          query
        );
      if (wantsSse) {
        writeSseEvent(res, "done", payload);
        res.end();
      } else {
        sendJson(res, 200, payload);
      }
    })
    .catch((err: Error) => {
      if (wantsSse && !res.headersSent) {
        openSseHeaders(res);
      }
      if (wantsSse) {
        writeSseEvent(res, "error", { error: err.message });
        res.end();
      } else {
        sendJson(res, 400, { error: err.message });
      }
    });
}

/**
 * Die Deps, die die Hook-Recall-Pipeline braucht (#265).
 *
 * Dieselben Werte, die die Route bisher als Einzelparameter durchreichte —
 * gebündelt, damit ein zweiter Aufrufer sie weitergeben kann, ohne die
 * Reihenfolge von sechs Positionsargumenten zu treffen.
 */
export interface HookRecallDeps {
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
  learnedBridges?: BridgePool | null;
  sharedRecallLang?: SupportedLanguage | null;
  embeddingDegraded?: () => boolean;
  /**
   * #264: Ist der Evidenzentscheid scharf? Fehlt der Getter, ist er AUS — und
   * aus heißt: Der Entscheid läuft und wird geloggt, wirkt aber auf nichts.
   * Beim Boot aufgelöst, wie `embeddingDegraded`.
   */
  evidenceGateEnabled?: () => boolean;
  /** Der Entscheid selbst, injizierbar. Default ist `decideHits` aus core;
   *  die Naht existiert, weil sich der fail-open-Pfad sonst nicht prüfen lässt
   *  — ein Defekt, der nur in echt auftritt, ist kein geprüfter Defekt. */
  decideFn?: typeof decideHits;
  /**
   * #491: das gelernte Latenzprofil des dichten Arms, im SCHATTEN. Fehlt es,
   * wird nichts gelernt und nichts protokolliert — an der Antwort ändert sich
   * so oder so nichts. Ein Bündel statt dreier Getter, weil Schlüssel, Residenz
   * und Profil nur gemeinsam eine Prognose ergeben.
   */
  deadlineShadow?: DeadlineShadow;
}

/**
 * Die Hook-Recall-Pipeline, aufrufbar (#265, §26.1).
 *
 * WARUM SIE HERAUSGELÖST IST. `/hook/recall` und der MCP-`recallHandler` sind
 * zwei verschiedene Pipelines, nicht zwei Aufrufe derselben: Nur dieser Weg
 * kennt den Scope-Filter (#110 Fremd-Scope-Hardfilter plus #148 Bypass für
 * absichtliche Cross-Scope-Treffer), die Reflex-Hits aus dem tieferen
 * Kandidatenpool und den Retrieval-Router-Schatten (#362). Solange die Pipeline
 * nur hinter der Route erreichbar war, konnte ein serverseitiger Aufrufer sie
 * nur über einen Loopback-Request bekommen — oder er nahm die andere Pipeline
 * und zeigte dem Nutzer stillschweigend eine andere Trefferauswahl.
 *
 * Der Rumpf ist wortgleich aus dem Routen-Handler übernommen; verändert wurden
 * genau die beiden Ränder, an denen er die HTTP-Antwort berührte: Der
 * SSE-Kopf bleibt in der Route, und die Stage-Events gehen über `emitStage`
 * nach draußen statt direkt auf den Response-Stream. Das Sammeln der Timings
 * bleibt drin, weil die Telemetrie am Ende der Pipeline sie liest.
 *
 * Wirft bei einem leeren `query` NICHT — die Route prüft das vorher, weil es
 * eine Eingabeprüfung ist und keine Retrieval-Entscheidung.
 */
/**
 * #1468: a memory past its own valid_until is not shown automatically. The
 * forwarder's MCP recall (`hook_source: "mcp"`) still gets it, marked
 * `expired_on`, like a direct recall.
 */
function withoutExpiredForHooks(hits: RecallHit[], vault: Vault, hookSource: unknown): RecallHit[] {
  if (hookSource === "mcp") return hits;
  return hits.filter((h) => !pastValidUntil(vault.get(h.id)?.fm ?? {}));
}

export async function runHookRecall(
  body: Record<string, unknown>,
  query: string,
  t0: number,
  deps: HookRecallDeps,
  emitStage?: (s: RecallStage) => void
): Promise<Record<string, unknown>> {
  const { vault, search, telemetry, learnedBridges, sharedRecallLang, embeddingDegraded } = deps;
  const {
    k,
    hookSessionId,
    hookToolName,
    hookProject,
    scope,
    type,
    expand_hops,
    vectorDeadlineMs,
    lexicalOnly,
    maxTokens,
    budgetMs,
    budgetSource,
    sessionStartCallId,
  } = readHookRecallInput(body);
  // #702: a replayed prompt (`bastra doctor --replay`) leaves the join
  // state alone — no turn, no hint window a real load_memory could close.
  const replay = body.client === "replay";
  if (hookToolName === "UserPromptSubmit" && !replay) {
    telemetry.rotateTurn(hookSessionId);
  }

  // #1513: stage timings, the degradation reason and the dense arm's own
  // report are collected from the stage events (hook-recall-measure.ts).
  const stages = createStageCollector();
  const stageTimings = stages.timings;

  // #265: Das Sammeln der Stage-Timings gehört zur Pipeline (die Telemetrie
  // unten liest sie); das WEITERREICHEN nach draußen ist Sache des
  // Aufrufers. Die Route hängt hier ihren SSE-Strom ein, der Assembler
  // nichts.
  const onStage: StageListener = (s: RecallStage) => {
    stages.collect(s);
    emitStage?.(s);
  };

  // Shared learned-recall (#120): widen the hook query with language-matched
  // bridge terms. No-op when the layer is off. This is the highest-volume
  // recall surface, so the bridge boost must reach it too — not just MCP recall.
  const expansion = expandQuery(query, learnedBridges, {
    configuredLang: sharedRecallLang ?? null,
  });
  // #121: capture the deeper candidate pool (incl. below-floor) for the far slice.
  let candidatePool: TelemetryPoolCandidate[] = [];
  const onQueryCandidatePool = (pool: RecallHit[]): void => {
    candidatePool = telemetryCandidatePool(pool, vault); // #1128-capture
  };
  const tRecall0 = Date.now();
  // #362 Phase 0: the event-loop probe around the recall (hook-recall-measure.ts).
  const loopProbe = startLoopProbe();
  // #165: VOR dem Recall festgehalten, damit der Flag den Recall
  // beschreibt, der tatsächlich serviert wird (siehe recallHandler).
  const embeddingDegradedAtRecall = search.hasEmbeddings() && (embeddingDegraded?.() ?? false);
  // #362: der Query-Router. Nur wo es einen dichten Arm gibt, den er
  // abwählen könnte — ohne Embeddings, bei offenem Breaker oder bei
  // `lexical_only` des Aufrufers gibt es nichts zu entscheiden. Beurteilt
  // wird die URSPRÜNGLICHE Anfrage, nicht die brückenerweiterte.
  const routerMode = queryRouterMode();
  const queryRoute: QueryRoute | null =
    routerMode !== "off" && search.hasEmbeddings() && !embeddingDegradedAtRecall && !lexicalOnly
      ? routeQueryArms(query)
      : null;
  const routedLexical = routerMode === "live" && queryRoute?.arms === "bm25";
  // Ab hier heißt „kein dichter Arm": der Aufrufer hat verzichtet ODER der
  // Router hat abgewählt. `lexicalOnly` selbst bleibt die Aussage des
  // Aufrufers — die Telemetriespalte gleichen Namens meint nur ihn.
  const skipDense = lexicalOnly || routedLexical;
  // #489: the late end of an abandoned dense arm, buffered until the
  // recall id exists; #491: the deadline shadow, read BEFORE the arm fires
  // (both in hook-recall-shadow.ts).
  const lateSettle = lateSettleRelay();
  const onVectorLateSettle = lateSettle.onSample;
  const deadlineShadow = startDeadlineShadow(
    deps.deadlineShadow,
    search.hasEmbeddings() && !embeddingDegradedAtRecall && !skipDense,
    replay
  );
  let hits: Awaited<ReturnType<typeof search.recallHybrid>>;
  {
    // #494: `lexicalOnly` schlägt `hasEmbeddings()` — der Verzicht ist eine
    // Entscheidung des Aufrufers und keine Eigenschaft der Maschine.
    hits =
      search.hasEmbeddings() && !skipDense
        ? await search.recallHybrid(expansion.query, {
            authored_query: query,
            k,
            scope,
            type,
            expand_hops,
            onStage,
            onCandidatePool: onQueryCandidatePool,
            vector_deadline_ms: vectorDeadlineMs,
            onVectorLateSettle,
          })
        : search.recall(expansion.query, {
            authored_query: query,
            k,
            scope,
            type,
            expand_hops,
            onStage,
            onCandidatePool: onQueryCandidatePool,
          });
  }

  // #342/P0: Lief für DIESE Anfrage eine echte Fusion? Direkt hier
  // festgehalten, weil der Content-Recall gleich seinen eigenen
  // Degradations-Grund bekommt und die beiden nicht vermischt werden dürfen.
  // #494: Ein `lexical_only`-Lauf ist nie fusioniert — es lief nur ein Arm,
  // also sind die Zahlen rohes BM25 und die 30/100-Bänder beschreiben sie
  // nicht (#302). Dass niemand ausgefallen ist, ändert daran nichts.
  const promptFused =
    search.hasEmbeddings() && !embeddingDegradedAtRecall && !skipDense && stages.degradedReason() === undefined;

  const content = await runContentRecall({
    body,
    search,
    hookToolName,
    query,
    hits,
    k,
    scope,
    type,
    expand_hops,
    skipDense,
    vectorDeadlineMs,
    embeddingDegradedAtRecall,
    promptFused,
  });
  hits = content.hits;
  hits = withoutExpiredForHooks(hits, vault, body.hook_source);
  const contentRecall = content.contentRecall;
  const probe = loopProbe.stop();
  const recallLatencyMs = Date.now() - tRecall0;
  const shadowRoute = shadowRouteFor(
    stageTimings,
    search.hasEmbeddings() && !embeddingDegradedAtRecall,
    budgetMs,
    vectorDeadlineMs
  );
  const totalLatencyMs = Date.now() - t0;
  // #491/#493: `budgetMs` ist die Wanduhr, die der AUFRUF mitbringt
  // (SessionStart 500, Prompt-Lane 200, MCP sein eigenes seit #493); `0`
  // heißt „kein Budget" und deckelt nicht. Die Query-Länge ist die, die der
  // DICHTE Arm bekommen hat: brückenerweitert, ungekappt (#362 kappt nur den
  // lexikalischen Arm).
  deadlineShadow.observe({
    stages,
    queryChars: expansion.query.length,
    spentBeforeRecallMs: tRecall0 - t0,
    budgetMs,
    budgetSource,
    deadlineMs: vectorDeadlineMs,
  });
  // #479: automatic hook hints get a version-local circuit breaker. Manual
  // recall is untouched; directives/reflexes are exempt inside the helper.
  // #484: `shadow` (default) counts what the breaker WOULD remove and
  // removes nothing; only `live` applies the cut. `off` skips the pass
  // entirely, so no would-be list is written either. Since #484 `live` can
  // no longer be armed from the environment — only a test seam reaches it,
  // see `hint-suppression.ts`.
  const suppressionMode = effectiveHintSuppressionMode();
  const usageSuppression =
    suppressionMode === "off"
      ? { kept: hits, suppressed: [] }
      : suppressRepeatedUnused(
          hits,
          (id) => vault.get(id),
          usageForShadow(vault.root),
          undefined,
          (hit) => Math.ceil(JSON.stringify(toLeanHit(hit)).length / 4)
        );
  if (suppressionMode === "live") hits = usageSuppression.kept;
  // #702: a replay's id is minted outside the join state — through
  // `newRecallId()` it would become the "latest recall" a real
  // load_memory/save_memory within five minutes is booked against.
  const recallId = replay ? randomUUID() : telemetry.newRecallId();
  if (!replay) telemetry.recordHookHints(recallId, hits, hookSessionId);
  // #489: Ab hier ist die `recall_id` bekannt — die späte Stichprobe kann
  // geschrieben werden. Ein Sample, das schon eingetroffen ist, wird
  // nachgeholt.
  lateSettle.bind(
    lateSettleSink({
      tracker: deadlineShadow,
      telemetry,
      recallId,
      vectorDeadlineMs,
      timings: stageTimings,
      sessionStartCallId,
      hookSessionId,
      body,
    })
  );

  const toolInputExcerpt = typeof body.tool_input_excerpt === "string" ? body.tool_input_excerpt.slice(0, 4096) : "";
  if (toolInputExcerpt) {
    for (const episode of telemetry.matchLoadedMemories({
      tool_name: hookToolName,
      tool_input_excerpt: toolInputExcerpt,
      session_id: hookSessionId,
    })) {
      fireAndForget(telemetry.logRecallEpisode(episode));
    }
  }

  // #249/#230: both honesty flags, computed ONCE for this recall and used by
  // the telemetry row and the payload alike. They were computed twice from
  // the same inputs before, which is how `no_home` came to be recorded on the
  // MCP path and nowhere here.
  // #342: a recall that fell back to one arm did not run RRF, whatever the
  // reason — breaker open (#165), deadline expired, or the arm returning
  // nothing. All three serve raw BM25, which is unbounded, so the 30/100
  // bands describe nothing and `unfused` has to say so (#302). Reading only
  // the breaker was already blind to `vector-arm-empty`; the deadline makes
  // that blind spot common instead of rare, which is why it is fixed here.
  // Nach dem Merge-Gate oben stammen alle servierten Hits entweder aus
  // beiden gleich fusionierten Recalls oder allein aus dem Prompt-Recall —
  // in beiden Fällen beschreibt `promptFused` die servierten Zahlen.
  const hybridActiveAtRecall = promptFused;
  const gateEnabled = deps.evidenceGateEnabled?.() === true;
  hits = applyEvidenceGate({
    hits,
    query,
    scope,
    vault,
    decideFn: deps.decideFn,
    telemetry,
    recallId,
    gateEnabled,
    degradedReason: stages.degradedReason(),
    hookSessionId,
    body,
  });

  // #421: Der Projekt-Scope-Filter der Prompt-Lane, hier für Aufrufer, die
  // ihn nicht selbst anwenden können — der MCP-Forwarder setzt
  // `apply_scope_filter` und schickt sein Projekt mit. Die Hook-Lanes
  // setzen das Feld nicht und filtern weiter selbst; für sie ändert sich
  // an dieser Antwort nichts. Nach dem Evidenz-Gate und vor den
  // Ehrlichkeitsflags, damit beide das beschreiben, was serviert wird.
  const callerScopeFilter =
    body.apply_scope_filter === true
      ? applyCallerScopeFilter(hits, {
          project: hookProject,
          explicitScope: scope !== undefined,
          unfused: !hybridActiveAtRecall,
          vault,
        })
      : null;
  if (callerScopeFilter) hits = callerScopeFilter.hits;

  const weakResult = isWeakResult(hits, hybridActiveAtRecall);
  const noHome = isNoHome(hits, hybridActiveAtRecall);

  // Pair hint metadata/revisions from the index; never open candidate files here.
  const conventionSources = await readRulebookSources(
    vault,
    [...hits.map((h) => h.id), ...candidatePool.map((h) => h.id)],
    hookSessionId
  );
  const budgeted = assembleHookRecallPayload({
    hits,
    candidatePool,
    vault,
    maxTokens,
    totalLatencyMs,
    recallId,
    weakResult,
    noHome,
    hookProject,
    hybridActiveAtRecall,
    degradedReason: stages.degradedReason(),
    conventionSources,
  });
  const { payload, budgetSize, budgetDropped } = await completeHookRecallPayload({
    budgeted,
    query,
    hits,
    vault,
    maxTokens,
    hookSessionId,
    bridgesFired: expansion.fired,
  });
  fireAndForget(
    telemetry.logHookRecall(
      hookRecallRow({
        body,
        query,
        recallId,
        hookSessionId,
        sessionStartCallId,
        hookToolName,
        hookProject,
        k,
        scope,
        type,
        maxTokens,
        vault,
        hits,
        usageSuppression,
        suppressionMode,
        recallLatencyMs,
        totalLatencyMs,
        stages,
        probe,
        deadlineShadowRow: deadlineShadow.row(),
        queryRoute,
        routerMode,
        routedLexical,
        shadowRoute,
        expansion,
        callerScopeFilter,
        candidatePool,
        hybridActiveAtRecall,
        contentRecall,
        embeddingDegradedAtRecall,
        lexicalOnly,
        weakResult,
        noHome,
        budgetSize,
        budgetDropped,
      })
    )
  );

  return payload;
}
