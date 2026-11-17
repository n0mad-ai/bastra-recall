/**
 * The shadow measurements of one hook recall (split out of `runHookRecall`,
 * #1513): the learned dense-arm deadline (#491/#493) and the retrieval
 * router's would-be route (#362 Phase 2). Both only record what a decision
 * WOULD have been; neither changes what the recall serves. The row
 * bookkeeping itself lives in `deadline-shadow-row.ts`.
 */
import { routeRetrieval, type LateSettleSample } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import type { DeadlineShadow } from "./latency-profile.js";
import {
  observeDeadlineShadow,
  recordLateSettleSample,
  logVectorLateSettleRow,
  type ObserveShadowInput,
} from "./deadline-shadow-row.js";
import type { StageCollector, StageTimings } from "./hook-recall-measure.js";

type DeadlineShadowRow = NonNullable<Parameters<Telemetry["logHookRecall"]>[0]["deadline_shadow"]>;

export interface DeadlineShadowTracker {
  shadow: DeadlineShadow | null;
  /** The row once {@link DeadlineShadowTracker.observe} produced one. */
  row: () => DeadlineShadowRow | undefined;
  observe: (
    input: Pick<
      ObserveShadowInput,
      "queryChars" | "spentBeforeRecallMs" | "budgetMs" | "budgetSource" | "deadlineMs"
    > & {
      stages: StageCollector;
    }
  ) => void;
  /** #491/#493: the late sample of an abandoned arm teaches the profile its cold tail. */
  learnLate: (sample: LateSettleSample) => void;
}

/**
 * #491: der Schatten. Er greift nur, wo es überhaupt einen dichten Arm gibt,
 * den er beschreiben könnte (`armFires`) — kein Provider oder ein offener
 * Breaker (#165) heißt: kein Arm, keine Prognose, keine Stichprobe. Ein vom
 * Breaker übersprungener Arm antwortet in ~0 ms, und diese Null als Latenz zu
 * lernen wäre schlimmer als gar nicht zu lernen.
 * #494: Ein `lexical_only`-Recall feuert keinen Arm, also gibt es auch nichts
 * zu prognostizieren.
 * #702: a replay teaches the latency profile nothing — its arm runs in a
 * burst of replayed turns, not under the user's load.
 *
 * Called BEFORE the recall: Ein Arm, der das Modell selbst lädt, macht es warm
 * — die Residenz NACH dem Aufruf beschriebe die Maschine, die er hinterlassen
 * hat, nicht die, auf die er traf. #493: Providercalls in Flug, inklusive
 * dieses — GELESEN statt selbst hochgezählt; der Zähler sitzt am Providerrand.
 */
export function startDeadlineShadow(
  deadlineShadow: DeadlineShadow | undefined,
  armFires: boolean,
  replay: boolean
): DeadlineShadowTracker {
  const key = armFires ? (deadlineShadow?.key() ?? null) : null;
  const shadow = key && !replay ? deadlineShadow! : null;
  const residency = shadow?.residency() ?? null;
  const concurrency = shadow ? shadow.profile.inFlight() + 1 : 0;
  let row: DeadlineShadowRow | undefined;
  return {
    shadow,
    row: () => row,
    // #491: Die Prognose gegen die Wirklichkeit — SCHATTEN. Gerechnet wird an
    // der Stelle, an der das Warten beginnt: NACH BM25. Der Überlapp ist genau
    // die Differenz der beiden #489-Zahlen.
    observe: (input) => {
      const vectorMs = input.stages.timings.vector_search_ms;
      const waitMs = input.stages.timings.vector_wait_ms;
      if (!shadow || !residency || vectorMs === undefined || waitMs === undefined) return;
      row = observeDeadlineShadow({
        shadow,
        key: key!,
        residency,
        concurrency,
        queryChars: input.queryChars,
        vectorMs,
        waitMs,
        spentBeforeRecallMs: input.spentBeforeRecallMs,
        budgetMs: input.budgetMs,
        budgetSource: input.budgetSource,
        deadlineMs: input.deadlineMs,
        timedOut: input.stages.degradedReason() === "vector-arm-timeout",
        report: input.stages.armReport(),
      });
    },
    learnLate: (sample) => {
      if (row && shadow && residency) recordLateSettleSample(shadow, key!, residency, row, sample);
    },
  };
}

/**
 * #489: Das echte Ende eines aufgegebenen Arms feuert erst, wenn der
 * weiterlaufende Embed fertig ist — da ist die Antwort längst raus. Gepuffert,
 * weil die `recall_id` erst NACH dem Recall gezogen wird: ein Arm, der eine
 * Millisekunde nach seiner Frist fertig wird, käme sonst vor ihr an. Der
 * Puffer ist genau ein Sample: pro Recall gibt es einen dichten Arm.
 */
export function lateSettleRelay(): {
  onSample: (sample: LateSettleSample) => void;
  bind: (sink: (sample: LateSettleSample) => void) => void;
} {
  let seen: LateSettleSample | null = null;
  let sink: ((sample: LateSettleSample) => void) | null = null;
  return {
    onSample: (sample) => {
      if (sink) sink(sample);
      else seen = sample;
    },
    bind: (next) => {
      sink = next;
      if (seen) next(seen);
    },
  };
}

/** The late-settle sink once the recall id is known: learn, then log the row. */
export function lateSettleSink(input: {
  tracker: DeadlineShadowTracker;
  telemetry: Telemetry;
  recallId: string;
  vectorDeadlineMs: number;
  timings: StageTimings;
  sessionStartCallId: string | null;
  hookSessionId: string | null;
  body: Record<string, unknown>;
}): (sample: LateSettleSample) => void {
  return (sample) => {
    input.tracker.learnLate(sample);
    logVectorLateSettleRow({
      telemetry: input.telemetry,
      recallId: input.recallId,
      vectorDeadlineMs: input.vectorDeadlineMs,
      waitMs: input.timings.vector_wait_ms ?? 0,
      sample,
      sessionStartCallId: input.sessionStartCallId,
      shadow: input.tracker.shadow,
      deadlineShadowRow: input.tracker.row(),
      hookSessionId: input.hookSessionId,
      body: input.body,
    });
  };
}

/**
 * #362 Phase 2: Schatten-Route. Die Suche ist zu diesem Zeitpunkt gelaufen —
 * entschieden wird hier nichts mehr, aufgezeichnet wird, was ein Router
 * entschieden HÄTTE. `terms_unique` stammt aus derselben Gruppierung, die der
 * Arm ohnehin gemacht hat, also kostet die Schattenrechnung nichts als eine
 * Multiplikation.
 */
export function shadowRouteFor(
  timings: StageTimings,
  denseAvailable: boolean,
  budgetMs: number,
  denseReservedMs: number
): ReturnType<typeof routeRetrieval> | undefined {
  if (typeof timings.terms_unique !== "number") return undefined;
  return routeRetrieval({ uniqueTerms: timings.terms_unique, denseAvailable, budgetMs, denseReservedMs });
}
