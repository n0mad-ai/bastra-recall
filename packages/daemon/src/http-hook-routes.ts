/**
 * Handlers for the loopback-only hook endpoints /hook/recall (JSON + SSE) and
 * /hook/act — the highest-volume recall surface and its act-signal companion.
 * Routing stays in http.ts; the handler logic lives here.
 * Split out of http.ts (file-size convention).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Vault,
  SearchIndex,
  RecallHit,
  RecallStage,
  StageListener,
} from "@bastra-recall/core";
import { vaultKnowsProject } from "./scope-filter.js";
import { routeRetrieval } from "@bastra-recall/core";
import { fireAndForget, type Telemetry } from "./telemetry.js";
import { envBool, envInt } from "./env.js";
import { computeSalienceShadow } from "./salience-shadow.js";
import { computeTrustShadow, trustRankMode, usageForShadow } from "./trust-shadow.js";
import { toLeanHit, truncateSummary } from "./tool-handlers.js";
import { expandQuery, type BridgePool } from "./learned-recall/bridges.js";
import { type SupportedLanguage } from "./learned-recall/language.js";
import { isWeakResult, isNoHome, decideHits, type RecallDecisionHit } from "@bastra-recall/core";
import { tokenizeWithIdentifiers } from "@bastra-recall/core";
import { armsOf, SCORE_VERSION } from "./score-space.js";
import {
  MAX_BODY_BYTES,
  clampInt,
  openSseHeaders,
  readJsonBody,
  sendJson,
  writeSseEvent,
} from "./http-util.js";

// ─── /hook/act handler (#144) ────────────────────────────────────

export function handleHookAct(req: IncomingMessage, res: ServerResponse, telemetry: Telemetry): void {
  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      const excerpt = typeof body.tool_input_excerpt === "string"
        ? body.tool_input_excerpt.slice(0, 4096)
        : "";
      if (!excerpt) {
        sendJson(res, 400, { error: "tool_input_excerpt is required" });
        return;
      }
      const toolName = typeof body.tool_name === "string" ? body.tool_name : null;
      const sessionId = typeof body.session_id === "string" ? body.session_id : null;
      const exitCode = typeof body.exit_code === "number" ? body.exit_code : null;

      const episodes = telemetry.matchLoadedMemories({
        tool_name: toolName,
        tool_input_excerpt: excerpt,
        session_id: sessionId,
        // High-frequency signal: only MATCHING episodes close; an unrelated
        // command must not kill an open episode with acted_on=false.
        closeOnMiss: false,
      });
      for (const episode of episodes) {
        fireAndForget(telemetry.logRecallEpisode(episode));
      }
      fireAndForget(
        telemetry.logHookAct({
          tool_name: toolName,
          excerpt_chars: excerpt.length,
          matched_episodes: episodes.length,
          exit_code: exitCode,
          // Claude-Session-id ins Event — ohne sie stempelt der Sink seine
          // Boot-UUID und der Transcript-Join ist unmöglich (Audit 2026-07-10).
          ...(sessionId ? { session_id: sessionId } : {}),
          // #263: Hinweise auf die Oberfläche. Ungeprüft weitergereicht — die
          // Allowlist und das Session-Pseudonym entstehen in der Telemetrie.
          client: body.client,
          hook_source: body.hook_source,
        }),
      );
      sendJson(res, 200, { matched: episodes.length });
    })
    .catch(() => sendJson(res, 400, { error: "invalid JSON body" }));
}

// ─── /hook/recall handler ────────────────────────────────────────

const CONTENT_RECALL_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * #342: deadline for the dense arm on the HOOK path only — the surface with a
 * hard client-side budget (HOOK_TIMEOUT_MS, 600ms). Offline callers (bridge
 * harvest, doc2query self-test, the WebUI) keep waiting indefinitely; they have
 * no budget and want the better result.
 *
 * The number comes from the per-stage split measured on a real host, and it is
 * a bound on THIS STAGE, not on the call:
 *
 *   warm   bm25 15-24ms   vector  87-96ms   →  total 106-113ms
 *   cold   bm25 24ms      vector 668ms      →  total 694ms
 *
 * So 150ms clears every warm dense arm with ~55ms to spare, and caps the cold
 * one at 150 + ~25ms of BM25 ≈ 180ms. That keeps BOTH cases under the 200ms
 * ceiling #305 set — the warm path untouched at ~110ms, the cold path degraded
 * to BM25-only but arriving, instead of the whole call expiring silently and
 * the turn continuing as if there had been nothing to say.
 *
 * 0 disables the deadline (kill switch, pre-#342 behaviour). Every expiry is
 * visible as `degraded: "vector-arm-timeout"` on the recall telemetry, so a
 * machine where the warm arm genuinely needs longer shows up as a rate rather
 * than as quietly worse recall.
 *
 * Read per call, not once at module load, like BASTRA_HOOK_CONTENT_RECALL
 * below: a latency kill switch that needs a daemon restart to take effect is
 * not much of a kill switch.
 */
const hookVectorDeadlineMs = (): number => envInt("BASTRA_VECTOR_DEADLINE_MS", 150);

/** #305/#362: Zielbudget der Hook-Lane in ms — die Zahl, gegen die der
 *  Schatten-Router seine Kostenschätzung hält. Das Milestone-Ziel ist 200. */
const hookBudgetMs = (): number => envInt("BASTRA_HOOK_BUDGET_MS", 200);

/**
 * Zwei Recalls über DASSELBE Memory zu einem Treffer zusammenlegen: der höhere
 * Score gewinnt, und zwar MIT seinem ganzen Beleg-Bündel.
 *
 * Codex-Gegenreview: Vorher wurde der Gewinner genommen, aber
 * `matched_recall_when` per ODER und `matched_terms` per Vereinigung aus BEIDEN
 * Treffern zusammengesetzt. Damit entstand ein Treffer, den es nie gab:
 * Prompt-Treffer mit Score 150 ohne Triggeranker + Content-Treffer mit Score 80,
 * `matched_recall_when: true` und `anchor_strength: "weak"` ergaben Score 150 UND
 * `matched_recall_when: true` — die `anchor_strength` blieb dabei weg, weil sie
 * vom Gewinner kam. Eine fehlende `anchor_strength` behandelt
 * `passesScopeFilter` aus Kompatibilitätsgründen wie den alten Boolean, also
 * genügten Flag + Score ≥ mustLoadScore für einen Cross-Scope-Bypass, den
 * keiner der beiden Recalls je gerechtfertigt hat.
 *
 * Score, Ankerstärke und Matchbeweis gehören zu EINER Query. Sie werden hier
 * deshalb nicht mehr getrennt: Der Gewinner geht unverändert weiter, die Belege
 * des Verlierers gehen mit dem Verlierer.
 */
export function mergeHookRecallHits(
  first: RecallHit[],
  second: RecallHit[],
  limit: number,
): RecallHit[] {
  const byId = new Map<string, RecallHit>();
  for (const hit of [...first, ...second]) {
    const previous = byId.get(hit.id);
    if (!previous || hit.score > previous.score) byId.set(hit.id, hit);
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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
): void {
  // SSE-Branch (#38): wenn der Caller `Accept: text/event-stream`
  // sendet, streamen wir Stages live. Default-JSON-Response bleibt
  // BC-erhalten — alte Hook-CLIs und REST-Caller sehen keinen
  // Unterschied.
  const accept = String(req.headers.accept ?? "");
  const wantsSse = accept.includes("text/event-stream");

  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
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
        { vault, search, telemetry, learnedBridges, sharedRecallLang, embeddingDegraded, evidenceGateEnabled },
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
          : undefined,
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
export async function runHookRecall(
  body: Record<string, unknown>,
  query: string,
  t0: number,
  deps: HookRecallDeps,
  emitStage?: (s: RecallStage) => void,
): Promise<Record<string, unknown>> {
  const { vault, search, telemetry, learnedBridges, sharedRecallLang, embeddingDegraded } = deps;
      const k = clampInt(body.k, 1, 10, 3);
      const hookSessionId = typeof body.session_id === "string" ? body.session_id : null;
      const hookToolName = typeof body.tool_name === "string" ? body.tool_name : null;
      const hookProject = typeof body.project === "string" ? body.project : null;
      if (hookToolName === "UserPromptSubmit") {
        telemetry.rotateTurn(hookSessionId);
      }
      const scope = typeof body.scope === "string" ? body.scope : undefined;
      const type = typeof body.type === "string" ? body.type : undefined;
      // expand_hops: Hooks profitieren vom Multi-Hop-Recall sobald
      // related_via befüllt ist (über RelatedEnricher). Default 1 — der
      // Caller kann explizit 0 schicken um es zu deaktivieren.
      const expand_hops = body.expand_hops === 0 ? 0 : 1;
      // 20.08.: the caller may widen the dense arm's deadline. The 150ms
      // default is sized for the 600ms hook budget; the MCP forwarder reuses
      // this route with a waiting model behind it and was paying the hook's
      // deadline for nothing — 15 of 19 MCP recalls on 20.08. came back
      // BM25-only because a 3-query batch (#351) serialises on one Ollama.
      const vectorDeadlineMs = clampInt(body.vector_deadline_ms, 50, 10_000, hookVectorDeadlineMs());

      const stageTimings: NonNullable<Parameters<Telemetry["logHookRecall"]>[0]["recall_stages"]> = {};
      // #342: why the hit list came back one-armed, if it did. Recorded rather
      // than merely returned — #305's whole finding is that this lane fails
      // quietly, and a degradation nobody counts repeats that failure one level
      // up: recall gets worse and the only visible symptom is that it got
      // faster. `vector-arm-timeout` is the deadline firing, `vector-arm-empty`
      // the pre-existing case where the arm had nothing to say.
      let degradedReason: string | undefined;
      const collectStage = (s: RecallStage): void => {
        if (s.name === "done" && typeof s.meta?.degraded === "string") {
          degradedReason = s.meta.degraded;
        }
        // #362 Phase 0: Die Querykosten reiten auf der bm25-Stage mit — sie
        // sagen, ob ein langsamer Aufruf viele Terme hatte oder viele
        // Wiederholungen, und das entscheidet, welcher Hebel überhaupt greift.
        if (s.name === "bm25.search") {
          const emitted = s.meta?.terms_emitted;
          const unique = s.meta?.terms_unique;
          if (typeof emitted === "number") stageTimings.terms_emitted = emitted;
          if (typeof unique === "number") stageTimings.terms_unique = unique;
        }
        if (s.name === "cache.hit") {
          stageTimings.cache_hit = true;
          return;
        }
        if (s.durationMs === undefined) return;
        switch (s.name) {
          case "query.parse": stageTimings.query_parse_ms = s.durationMs; break;
          case "bm25.search": stageTimings.bm25_search_ms = s.durationMs; break;
          case "vector.search": stageTimings.vector_search_ms = s.durationMs; break;
          case "rrf.fuse": stageTimings.rrf_fuse_ms = s.durationMs; break;
          case "hops.expand": stageTimings.hops_expand_ms = s.durationMs; break;
          case "staleness.rank": stageTimings.staleness_rank_ms = s.durationMs; break;
        }
      };

      // #265: Das Sammeln der Stage-Timings gehört zur Pipeline (die Telemetrie
      // unten liest sie); das WEITERREICHEN nach draußen ist Sache des
      // Aufrufers. Die Route hängt hier ihren SSE-Strom ein, der Assembler
      // nichts.
      const onStage: StageListener = (s: RecallStage) => {
        collectStage(s);
        emitStage?.(s);
      };

      // Shared learned-recall (#120): widen the hook query with language-matched
      // bridge terms. No-op when the layer is off. This is the highest-volume
      // recall surface, so the bridge boost must reach it too — not just MCP recall.
      const expansion = expandQuery(query, learnedBridges, {
        configuredLang: sharedRecallLang ?? null,
      });
      // #121: capture the deeper candidate pool (incl. below-floor) for the far slice.
      let candidatePool: { id: string; score: number }[] = [];
      const onQueryCandidatePool = (pool: { id: string; score: number }[]): void => {
        candidatePool = pool.map((h) => ({ id: h.id, score: h.score }));
      };
      const tRecall0 = Date.now();
      // #362 Phase 0: Wie lange blockiert der synchrone lexikalische Arm den
      // Event Loop? Ein Timer, der alle 10 ms feuern SOLL, aber erst nach 400 ms
      // drankommt, hat 390 ms Blockade gemessen — ohne Instrumentierung im
      // Suchcode selbst, und ohne perf_hooks-Histogramm, das über den ganzen
      // Prozess mittelt statt diesen einen Aufruf zu beschreiben.
      //
      // Die Zahl ist die Vorbedingung dafür, einen Worker später überhaupt
      // bewerten zu können: Er macht die Rechnung nicht schneller, er gibt nur
      // den Loop frei. Ohne Vorher-Wert ist der Nachher-Wert bedeutungslos.
      // ACHTUNG, gemessene Grenze dieser Sonde: Sie sieht nur Blockaden, die ein
      // `await` überspannen. Auf einer Maschine OHNE Embeddings läuft
      // `search.recall()` durchgehend synchron — der Timer bekommt bis zum
      // `clearInterval` nie eine Gelegenheit zu feuern und meldet 0, obwohl der
      // Loop die ganze Zeit stand. Für diesen Fall ist `bm25_search_ms` der
      // ehrlichere Blockade-Wert, und genau so wird er unten auch verwendet.
      const loopProbeEveryMs = 10;
      let loopTicks = 0;
      let loopBlockMs = 0;
      let lastTick = Date.now();
      const loopProbe = setInterval(() => {
        loopTicks++;
        const now = Date.now();
        const lag = now - lastTick - loopProbeEveryMs;
        if (lag > loopBlockMs) loopBlockMs = lag;
        lastTick = now;
      }, loopProbeEveryMs);
      loopProbe.unref?.();
      // #165: VOR dem Recall festgehalten, damit der Flag den Recall
      // beschreibt, der tatsächlich serviert wird (siehe recallHandler).
      const embeddingDegradedAtRecall =
        search.hasEmbeddings() && (embeddingDegraded?.() ?? false);
      let hits = search.hasEmbeddings()
        ? await search.recallHybrid(expansion.query, {
            authored_query: query,
            k,
            scope,
            type,
            expand_hops,
            onStage,
            onCandidatePool: onQueryCandidatePool,
            vector_deadline_ms: vectorDeadlineMs,
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

      // #342/P0: Lief für DIESE Anfrage eine echte Fusion? Direkt hier
      // festgehalten, weil der Content-Recall gleich seinen eigenen
      // Degradations-Grund bekommt und die beiden nicht vermischt werden dürfen.
      const promptFused =
        search.hasEmbeddings() && !embeddingDegradedAtRecall && degradedReason === undefined;

      const contentQuery = typeof body.tool_input_excerpt === "string"
        ? body.tool_input_excerpt.trim().slice(0, 4096)
        : "";
      let contentRecall:
        | {
            hit_count: number;
            added_count: number;
            rescored_count: number;
            latency_ms: number;
            failed?: boolean;
            skipped_score_space?: true;
          }
        | undefined;
      if (
        envBool("BASTRA_HOOK_CONTENT_RECALL", false)
        && CONTENT_RECALL_TOOLS.has(hookToolName ?? "")
        && contentQuery
        && contentQuery !== query
      ) {
        const contentRecallStarted = Date.now();
        try {
          // Codex-Gegenreview: Der Content-Recall ist ein EIGENER Recall und
          // degradiert unabhängig — sein Vektor-Arm kann in die Deadline laufen,
          // während der Prompt-Recall fusioniert hat. Sein Degradations-Grund
          // ging bisher verloren (kein onStage), und der Score-Modus wurde nur
          // aus dem ERSTEN Recall abgeleitet. Ergebnis: rohe BM25-Werte, in eine
          // RRF-Liste einsortiert und als „rrf" gemeldet.
          let contentDegradedReason: string | undefined;
          const collectContentStage = (st: RecallStage): void => {
            if (st.name === "done" && typeof st.meta?.degraded === "string") {
              contentDegradedReason = st.meta.degraded;
            }
          };
          const contentHits = search.hasEmbeddings()
            ? await search.recallHybrid(contentQuery, {
                k,
                scope,
                type,
                expand_hops,
                onStage: collectContentStage,
                // Same deadline, not a remaining-budget split: by the time this
                // runs the query recall above has either warmed the model (so
                // this costs ~120ms) or is still loading it (so this expires
                // too and degrades the same way). Both are the right outcome.
                vector_deadline_ms: vectorDeadlineMs,
              })
            : search.recall(contentQuery, {
                k,
                scope,
                type,
                expand_hops,
              });
          const contentFused =
            search.hasEmbeddings() && !embeddingDegradedAtRecall && contentDegradedReason === undefined;
          if (contentFused !== promptFused) {
            // Fail-closed: Die beiden Listen liegen in verschiedenen Räumen, und
            // „der höhere Score gewinnt" heißt dann nur „die Skala ohne
            // Obergrenze gewinnt". Der Content-Arm fällt weg, statt die
            // fusionierte Liste zu verunreinigen — die servierten Zahlen kommen
            // dann alle aus dem Prompt-Recall und `score_kind` beschreibt sie.
            contentRecall = {
              hit_count: contentHits.length,
              added_count: 0,
              rescored_count: 0,
              latency_ms: Date.now() - contentRecallStarted,
              skipped_score_space: true,
            };
          } else {
            const queryHitsById = new Map(hits.map((hit) => [hit.id, hit]));
            const contentHitsById = new Map(contentHits.map((hit) => [hit.id, hit]));
            const mergedHits = mergeHookRecallHits(hits, contentHits, k);
            contentRecall = {
              hit_count: contentHits.length,
              added_count: mergedHits.filter((hit) => !queryHitsById.has(hit.id)).length,
              rescored_count: mergedHits.filter((hit) => {
                const queryHit = queryHitsById.get(hit.id);
                const contentHit = contentHitsById.get(hit.id);
                return queryHit !== undefined
                  && contentHit !== undefined
                  && contentHit.score > queryHit.score;
              }).length,
              latency_ms: Date.now() - contentRecallStarted,
            };
            hits = mergedHits;
          }
        } catch {
          contentRecall = {
            hit_count: 0,
            added_count: 0,
            rescored_count: 0,
            latency_ms: Date.now() - contentRecallStarted,
            failed: true,
          };
        }
      }
      clearInterval(loopProbe);
      const recallLatencyMs = Date.now() - tRecall0;
      // #362 Phase 2: Schatten-Route. Die Suche ist zu diesem Zeitpunkt
      // gelaufen — entschieden wird hier nichts mehr, aufgezeichnet wird, was
      // ein Router entschieden HÄTTE. `terms_unique` stammt aus derselben
      // Gruppierung, die der Arm ohnehin gemacht hat, also kostet die
      // Schattenrechnung nichts als eine Multiplikation.
      const shadowRoute =
        typeof stageTimings.terms_unique === "number"
          ? routeRetrieval({
              uniqueTerms: stageTimings.terms_unique,
              denseAvailable: search.hasEmbeddings() && !embeddingDegradedAtRecall,
              budgetMs: hookBudgetMs(),
              denseReservedMs: vectorDeadlineMs,
            })
          : undefined;
      const totalLatencyMs = Date.now() - t0;
      const recallId = telemetry.newRecallId();
      telemetry.recordHookHints(recallId, hits);

      const toolInputExcerpt = typeof body.tool_input_excerpt === "string"
        ? body.tool_input_excerpt.slice(0, 4096)
        : "";
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
      // #264: Der Evidenzentscheid. Hier und nicht später, weil die Treffer an
      // dieser Stelle noch ihre Hop-Herkunft tragen — die Projektion unten
      // wirft sie weg, und C-046 verlangt sie am Entscheidungspunkt.
      //
      // Die Merkmale werden gegen die URSPRÜNGLICHE Anfrage erhoben, nicht
      // gegen die brückenerweiterte: Beurteilt wird, was der Nutzer gefragt
      // hat, nicht was die Suche daraus gemacht hat.
      let decisions: RecallDecisionHit[] | null = null;
      try {
        decisions = (deps.decideFn ?? decideHits)(hits, {
          queryTerms: tokenizeWithIdentifiers(query),
          scope: scope ?? null,
          memoryOf: (id) => vault.get(id),
        });
        const counts = { required: 0, optional: 0, no_answer: 0 };
        for (const d of decisions) counts[d.decision]++;
        const hopOf = new Map(hits.map((h) => [h.id, h.hop]));
        fireAndForget(
          telemetry.logEvidenceDecision({
            recall_id: recallId,
            // Solange das Flag aus ist, ist die Entscheidung reine Beobachtung.
            shadow: !gateEnabled,
            // C-047/C-052: Ein Budget-Abbruch ist keine Abstention. Wer die
            // Quote rechnet, muss diese Läufe ausschließen können.
            degraded: degradedReason !== undefined,
            decisions: decisions.map((d) => ({
              memory_id: d.id,
              decision: d.decision,
              ...(d.abstain_reason ? { abstain_reason: d.abstain_reason } : {}),
              evidence: d.evidence,
              ...(hopOf.get(d.id) ? { hop: hopOf.get(d.id) } : {}),
            })),
            counts,
            ...(hookSessionId ? { session_id: hookSessionId } : {}),
            client: body.client,
            hook_source: body.hook_source,
          }),
        );
      } catch (err) {
        // Ein Defekt im Entscheid geht in KEINE der beiden Statistiken
        // (C-047/C-052) — leere Entscheidungen, Zähler auf null. Sichtbar
        // bleibt er trotzdem, sonst wäre er von einem Aufruf ohne Treffer nicht
        // zu unterscheiden. `decisions` bleibt null, und damit filtert der Gate
        // unten nichts: fail-open, wie überall auf dem Hook-Pfad.
        decisions = null;
        console.error(`[bastra.evidence] decision failed: ${(err as Error).message}`);
        fireAndForget(
          telemetry.logEvidenceDecision({
            recall_id: recallId,
            shadow: !gateEnabled,
            degraded: degradedReason !== undefined,
            failed: true,
            decisions: [],
            counts: { required: 0, optional: 0, no_answer: 0 },
            ...(hookSessionId ? { session_id: hookSessionId } : {}),
            client: body.client,
            hook_source: body.hook_source,
          }),
        );
      }

      // Scharf geschaltet heißt: `no_answer` wird respektiert — die vorhandene
      // Evidenz reichte für keine Ausspielung (§10.3), also wird nichts
      // ausgespielt. Ausgeschaltet ändert diese Zeile nichts, und das ist der
      // Auslieferungszustand (§21.1: erst shadow, dann aktiv).
      if (gateEnabled && decisions) {
        const suppressed = new Set(
          decisions.filter((d) => d.decision === "no_answer").map((d) => d.id),
        );
        if (suppressed.size > 0) hits = hits.filter((h) => !suppressed.has(h.id));
      }

      const weakResult = isWeakResult(hits, hybridActiveAtRecall);
      const noHome = isNoHome(hits, hybridActiveAtRecall);

      fireAndForget(
        telemetry.logHookRecall({
          recall_id: recallId,
          query,
          // #363: die Claude-Session-id aus dem Hook-Payload ins Event — ohne
          // sie stempelt der Sink seine Boot-UUID und keine Auswertung auf
          // Recall-Ebene kann nach Session oder Turn gruppieren. Der Wert war
          // längst hier (oben als hookSessionId gelesen, für rotateTurn und
          // matchLoadedMemories genutzt), nur nicht am Event. Gleiche Form wie
          // logHookAct/logHookReflex: fehlt sie, bleibt die Boot-UUID.
          ...(hookSessionId ? { session_id: hookSessionId } : {}),
          // #263: Oberflächen-Hinweise. `hook_source` trennt die Lanes
          // voneinander UND vom MCP-Forwarder, der `recall` über denselben
          // Endpunkt proxyt — ohne die Spalte wären beide dasselbe Ereignis.
          client: body.client,
          hook_source: body.hook_source,
          // #351: batch width when this recall is one phrasing of a batch.
          query_count: typeof body.batch_of === "number" ? body.batch_of : undefined,
          topics: Array.isArray(body.topics)
            ? (body.topics as unknown[]).filter((t): t is string => typeof t === "string")
            : [],
          tool_name: hookToolName,
          project: hookProject,
          k,
          scope: scope ?? null,
          type: type ?? null,
          vault_size: vault.size(),
          hit_count: hits.length,
          top_score: hits[0]?.score ?? null,
          hits: hits.map((h) => ({
            id: h.id,
            score: h.score,
            type: h.type,
            // #263: die Hop-Herkunft, die §18.2 fürs M1-Gate braucht.
            ...(h.hop ? { hop: h.hop } : {}),
          })),
          latency_ms_recall: recallLatencyMs,
          latency_ms_total: totalLatencyMs,
          recall_stages: stageTimings,
          // #362 Phase 0: nur melden, wenn überhaupt spürbar blockiert wurde —
          // eine 0 in jedem Event wäre Rauschen, das die Auswertung verwässert.
          // Hat die Sonde überhaupt getickt? Wenn nicht, lief alles synchron und
          // die Blockade ist die Rechenzeit selbst — sonst stünde hier eine 0,
          // die wie „kein Problem" aussieht und genau den Fall verschweigt, für
          // den die Zahl gedacht war.
          ...(loopTicks === 0
            ? {
                event_loop_block_ms: stageTimings.bm25_search_ms ?? recallLatencyMs,
                event_loop_block_source: "sync-fallback" as const,
              }
            : loopBlockMs >= loopProbeEveryMs
              ? { event_loop_block_ms: loopBlockMs, event_loop_block_source: "probe" as const }
              : {}),
          ...(shadowRoute
            ? {
                shadow_route: {
                  mode: shadowRoute.mode,
                  estimated_lexical_ms: Math.round(shadowRoute.estimatedLexicalMs),
                  lexical_fits: shadowRoute.lexicalFits,
                  unique_terms: stageTimings.terms_unique as number,
                },
              }
            : {}),
          bridge_expansion:
            expansion.lang && expansion.added.length > 0 ? { lang: expansion.lang, added: expansion.added } : undefined,
          candidate_pool: candidatePool.length > 0 ? candidatePool : undefined,
          // Zweiter Gegenreview: derselbe explizite Raum wie auf dem Response.
          // `top_score` und `candidate_pool` sind sonst Zahlen ohne Skala, und
          // eine Auswertung, die sie über degradierte und fusionierte Recalls
          // hinweg mittelt, misst zwei verschiedene Größen als eine.
          score_kind: hybridActiveAtRecall ? ("rrf" as const) : ("bm25" as const),
          score_arms: armsOf({ hybridActive: hybridActiveAtRecall, commonsFused: false }),
          score_version: hybridActiveAtRecall ? SCORE_VERSION : undefined,
          candidate_pool_score_kind:
            candidatePool.length > 0 ? (hybridActiveAtRecall ? ("rrf" as const) : ("bm25" as const)) : undefined,
          // Codex-Gegenreview (P1): Der Pool trug nur seinen `score_kind`.
          // Gemessen: `top_score: 150` aus drei Armen gegen einen Pool mit
          // Spitzenwert 80 aus zwei Armen — beide meldeten `"rrf"`, also hielt
          // `extractCandidatePools()` sie für denselben Raum und las die 150
          // als Pool-Score. Der Pool braucht dieselbe volle Signatur wie der
          // Haupt-Score: Kind + Version + Armmenge.
          candidate_pool_score_arms:
            candidatePool.length > 0
              ? armsOf({ hybridActive: hybridActiveAtRecall, commonsFused: false })
              : undefined,
          // Version NUR auf der fusionierten Skala — dieselbe Regel wie beim
          // Haupt-Score, auf rohem BM25 gibt es keine Formel zu versionieren.
          candidate_pool_score_version:
            candidatePool.length > 0 && hybridActiveAtRecall ? SCORE_VERSION : undefined,
          content_recall: contentRecall,
          // #165: pre-recall festgehalten, siehe oben / recallHandler.
          embedding_degraded: embeddingDegradedAtRecall ? true : undefined,
          // #342: which arm dropped out, if one did.
          degraded_reason: degradedReason,
          // #217: would-be Salience-Reihenfolge (shadow-only).
          salience_shadow: computeSalienceShadow(
            hits,
            (id) => vault.get(id)?.fm as Record<string, unknown> | undefined,
          ),
          // #160: dieselbe Projektion für den Trust-Multiplikator. MUSS hier
          // stehen und nicht nur im MCP-Pfad: der Hook ist der häufigere
          // Aufrufer, und ein Shadow, der nur die Tool-Calls sieht, misst eine
          // Verteilung, die es so nicht gibt.
          trust_shadow:
            trustRankMode() === "shadow"
              ? computeTrustShadow(hits, (id) => usageForShadow(vault.root)[id])
              : undefined,
          // #249: recorded, not just returned. Without this the flag reads
          // zero in every stats run — not because recall is healthy, but
          // because nothing ever wrote it down.
          weak_result: weakResult || undefined,
          no_home: noHome || undefined,
        }),
      );

      // Lean projection (#50): the hook CLI only consumes lean fields, so we
      // never need to send matched_terms/mode/hop/topic_path over the wire.
      // Telemetry above already logged the full hits. #148: the hook scope
      // filter needs the one extra bit `matched_recall_when` (kept here only,
      // not in the shared toLeanHit — MCP recall stays the documented lean shape).
      // #249: the honesty flag has to reach THIS path above all. /hook/recall
      // writes <recall-hints> into the agent's context on every Bash and Edit,
      // and without the flag the formatters label pure noise as "Strong
      // matches" — the daemon computed the contradicting signal and simply did
      // not send it. Same computation as the MCP path, from the same module.
      // 20.08.: reflex-wired memories (recall_mode "reflex") from the deeper
      // candidate pool that the top-k cut left out. The prompt lane's semantic
      // reflex filter only ever saw `hits`; on 20.08. the wired convention sat
      // at pool rank 6 behind a k of 5 and never reached the agent. The pool is
      // the user's explicit wiring — two memories — so scanning it is cheap,
      // and the lane keeps every floor and dedup it already applies.
      const hitIds = new Set(hits.map((h) => h.id));
      const reflexHits = candidatePool.flatMap((c) => {
        if (hitIds.has(c.id)) return [];
        const mem = vault.get(c.id);
        if (mem?.fm.recall_mode !== "reflex") return [];
        return [{
          id: c.id,
          title: mem.fm.title,
          type: mem.fm.type,
          scope: mem.fm.scope,
          summary: truncateSummary(mem.fm.summary),
          score: c.score,
          matched_recall_when: false,
          recall_mode: "reflex" as const,
        }];
      });
      const payload = {
        // recall_mode rides along only when the user wired the memory as
        // reflex: the prompt lane's mode-"none" semantic filter keys on it
        // (19.08. incident — see prompt-lane.ts).
        hits: hits.map((h) => ({
          ...toLeanHit(h),
          matched_recall_when: h.matched_recall_when ?? false,
          // P0: Der Cross-Scope-Bypass in den Lanes braucht mehr als das Flag —
          // ein einzelnes häufiges Wort in einer fremden Triggerphrase ist
          // keine Absicht. Nur gesetzt, wenn überhaupt ein Trigger-Term traf.
          ...(h.anchor_strength ? { anchor_strength: h.anchor_strength } : {}),
          ...(vault.get(h.id)?.fm.recall_mode === "reflex" ? { recall_mode: "reflex" as const } : {}),
        })),
        ...(reflexHits.length > 0 ? { reflex_hits: reflexHits } : {}),
        vault_size: vault.size(),
        latency_ms: totalLatencyMs,
        recall_id: recallId,
        ...(weakResult ? { weak_result: true } : {}),
        // #230: the stricter half travels the same wire. A strict subset of
        // weak_result, so a consumer that only knows weak_result is unaffected.
        ...(noHome ? { no_home: true } : {}),
        // #302: whether RRF ran at all. Without a vector arm there is no
        // fusion and no ceiling — raw BM25 is unbounded (top hits into six
        // digits on a real vault), so the 30/100 cuts describe nothing there.
        // The formatter has to say so rather than band an unbounded scale.
        // Same shape as the flags above: present only when it has something
        // to say, computed once from the value the honesty flags already use.
        // P0: derselbe explizite Score-Raum wie auf dem MCP-Pfad. `unfused`
        // sagt es indirekt, aber ein Konsument soll das Feld lesen können,
        // statt aus einer Abwesenheit zu schließen.
        // Codex-Gegenreview zum Confidence-Gate: Kennt der Vault den
        // Projektnamen überhaupt? `detectProject()` liefert für
        // `/workspace/packages/core` das Projekt "packages" — mit voller
        // Zuversicht, denn ein Pfadsegment hieß "workspace". Ein scharfer
        // Scope-Filter würde damit das ganze eigene Gedächtnis entfernen.
        // Die Frage ist nur HIER beantwortbar, wo der Vault liegt; die Lanes
        // sehen ihn nicht. Früher Abbruch beim ersten Treffer: der Normalfall
        // (eigenes Projekt) kostet nichts, nur der seltene Fehlerfall läuft
        // einmal durch.
        ...(hookProject !== null ? { project_known: vaultKnowsProject(vault, hookProject) } : {}),
        score_kind: hybridActiveAtRecall ? ("rrf" as const) : ("bm25" as const),
        // Dieselbe Angabe wie auf dem MCP-Pfad: `score_kind` allein macht zwei
        // Zahlen nicht vergleichbar, die Armmenge tut es. Der Hook-Pfad kennt
        // keine Commons — hier sind es immer die persönlichen Arme, und genau
        // das muss auf der Leitung stehen, statt vom Konsumenten geraten zu
        // werden.
        score_arms: armsOf({ hybridActive: hybridActiveAtRecall, commonsFused: false }),
        // Keine Formelversion auf einer rohen Skala — siehe recall-handler.ts.
        ...(hybridActiveAtRecall ? { score_version: SCORE_VERSION } : { unfused: true }),
        // #342: name the reason on the wire too. `unfused` says the bands do
        // not apply; this says why, so a slow machine degrading on every call
        // is distinguishable from embeddings being off — from the response
        // alone, without correlating against the telemetry log.
        ...(degradedReason ? { degraded: degradedReason } : {}),
      };
      return payload;
}
