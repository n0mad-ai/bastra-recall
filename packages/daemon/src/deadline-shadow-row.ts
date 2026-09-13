/**
 * Die Buchführung des Deadline-Schattens für EINEN Recall (#491/#493).
 *
 * Herausgelöst aus `http-hook-routes.ts`, weil sie dort als zusammenhängender
 * Block von gut hundert Zeilen mitten in der Recall-Pipeline saß und mit #493
 * weiter gewachsen wäre — die Datei liegt seit längerem über der
 * 800-Zeilen-Grenze. Der Schnitt liegt an einer echten fachlichen Naht: Die
 * Pipeline stellt fest, WAS passiert ist; dieses Modul entscheidet, was davon
 * eine Stichprobe ist und wie die Schattenzeile aussieht.
 *
 * Zwei Ein-/Ausgänge, weil ein Recall den Schatten zweimal berührt:
 *
 *   {@link observeDeadlineShadow}  — direkt nach dem Recall. Der Arm hat
 *     entweder gesettelt (dann ist er seine eigene Gesamtzeit) oder wurde
 *     aufgegeben (dann steht die Wirklichkeit noch aus).
 *   {@link recordLateSettleSample} — wenn der aufgegebene Arm wirklich fertig
 *     ist. Das ist die einzige Zeile, die den kalten Schwanz sieht.
 *
 * Ändert an keiner Antwort etwas: reiner Schatten, bis das Zeit-Tor aus #492
 * geöffnet ist.
 */
import { PROVIDER_COLD_LOAD_MS, type LateSettleSample } from "@bastra-recall/core";
import type { Residency, ResidencyReading } from "./embedding-warmup.js";
import type { DeadlineShadow } from "./latency-profile.js";
import type { DeadlineShadowRow } from "./telemetry-events.js";

/**
 * Was der dichte Arm über sich selbst berichtet hat (#493) — aus der
 * `vector.search`-Stage. `null`, solange der Arm noch läuft (Timeout): Dann
 * gibt es noch keinen Ausgang, und die späte Stichprobe trägt ihn nach.
 */
export interface VectorArmReport {
  outcome: "hits" | "empty" | "error";
  /** Rohe Treffer des Providers, vor dem Vault-Filter. */
  hit_count: number;
  provider_load_ms: number | null;
  cold_start_observed: boolean;
}

/**
 * Ist DAS eine Latenzstichprobe? Nur ein Arm, der wirklich Treffer geliefert
 * hat (#493).
 *
 * `error` war der eigentliche Defekt: Ein Providerfehler kam als aufgelöste
 * Promise zurück, `abandonAfter` las darin ein `settled: true`, und die Dauer
 * eines HTTP 500 wurde als „normaler dichter Arm" gelernt. `empty` fällt aus
 * einem zweiten Grund heraus — der häufigste Unterfall (Vault ohne Vektoren)
 * macht überhaupt keinen Providercall, seine Dauer ist also gar keine
 * Providerdauer.
 */
export function isLatencySample(report: VectorArmReport | null | undefined): boolean {
  return report?.outcome === "hits";
}

/**
 * Unter WELCHER Residenz diese Stichprobe abgelegt gehört (#499).
 *
 * Der Defekt: Prognose und Stichprobe teilten sich die Vorab-Lesung. Die ist
 * für die Prognose richtig — auf ihr wurde entschieden — und für die
 * Stichprobe falsch, sobald der Provider hinterher etwas anderes belegt.
 * Livezeile der ersten Messnacht (09.09.2026):
 *
 *   residency: cold   residency_source: last-ok   residency_estimated: true
 *   provider_load_ms: 0.800791   cold_start_observed: false
 *   actual_settle_ms: 85   bucket: cold|xs|2-3
 *
 * Ollamas `load_duration` ist genau der Beleg: 0,8 ms lädt kein Modell, das
 * nicht schon im Speicher liegt. Trotzdem landete der Call im kalten Eimer —
 * und `cold|xs|2-3 = [85]` war der einzige kalte Eintrag im ganzen Profil.
 * Die kalte Trainingsmenge bestand damit zu 100 % aus einem warmen Call, und
 * der hierarchische Rückfall (#493) hätte jeden echten Kaltstart gegen 85 ms
 * prognostiziert, wo real 525 ms stehen.
 *
 * Die Schwelle ist dieselbe, an der auch `cold_start_observed` und Tor 3 aus
 * #492 hängen ({@link PROVIDER_COLD_LOAD_MS}) — eine Residenzgrenze, nicht
 * zwei. Ohne gemeldeten Ladewert bleibt es bei der Vorab-Lesung: keine
 * Grundwahrheit, keine Umbuchung. Und `hosted` kennt kein Modell, das laden
 * könnte; dort gibt es nichts zu klassifizieren.
 */
export function sampleResidency(
  reading: ResidencyReading,
  providerLoadMs: number | null | undefined,
): Residency {
  if (reading.state === "hosted") return "hosted";
  if (typeof providerLoadMs !== "number" || !Number.isFinite(providerLoadMs)) return reading.state;
  return providerLoadMs >= PROVIDER_COLD_LOAD_MS ? "cold" : "warm";
}

export interface ObserveShadowInput {
  shadow: DeadlineShadow;
  /** `provider:model`. */
  key: string;
  residency: ResidencyReading;
  /** Providercalls in Flug beim Abfeuern DIESES Arms, inklusive seiner selbst. */
  concurrency: number;
  /** Zeichen der (brückenerweiterten, ungekappten) Query, die der Arm bekam. */
  queryChars: number;
  /** `vector_search_ms` — die Spanne ab dem Abfeuern (überlappt BM25). */
  vectorMs: number;
  /** `vector_wait_ms` — was der Aufrufer wirklich gewartet hat (#489). */
  waitMs: number;
  /** Was die Lane an ihrer Wanduhr verbraucht hatte, bevor der Recall begann. */
  spentBeforeRecallMs: number;
  /** Die Wanduhr der Lane. `0` = keine. */
  budgetMs: number;
  /**
   * WOHER die Wanduhr kommt (#493). `caller` = der Aufrufer hat sein echtes
   * Restbudget geschickt; `endpoint-default` = er hat keines geschickt und die
   * Route hat ihre eigene Zahl eingesetzt.
   *
   * #495 — AUSWERTUNGSREGEL für das Fenster aus #492: MCP-Zeilen mit
   * `endpoint-default` gehören nicht in die Auswertung. Der Forwarder schickt
   * sein Budget seit #493 (`mcp-forwarder.ts`), aber langlebige
   * Forwarder-Prozesse überleben jeden Daemon-Neustart (das Stale-Forwarder-
   * Muster aus #132) — am 08.09.2026 liefen vier davon, bis zu 8 Tage alt, und
   * schrieben weiter `lane_budget_ms: 200, budget_source: endpoint-default`.
   * Solche Zeilen sind gegen die Wanduhr einer FREMDEN Lane geschattet und
   * beantworten Kriterium 4 nicht. Die Regel steht auch als Kommentar an #492.
   */
  budgetSource: "caller" | "endpoint-default";
  /** Die Frist, die tatsächlich galt. */
  deadlineMs: number;
  timedOut: boolean;
  /** Der Bericht des Arms, `null` beim Timeout. */
  report: VectorArmReport | null;
}

/**
 * Rechnet die Prognose, lernt die Stichprobe (sofern es eine ist) und baut die
 * Telemetriezeile.
 */
export function observeDeadlineShadow(input: ObserveShadowInput): DeadlineShadowRow {
  const { shadow, key, residency, report } = input;
  // Der Überlapp ist genau die Differenz der beiden #489-Zahlen: Die Spanne ab
  // Abfeuern minus die Wartezeit ab dem `await` ist das, was der Arm im
  // Schatten von BM25 schon verbraucht hatte.
  const overlapMs = Math.max(0, input.vectorMs - input.waitMs);
  const spentMs = input.spentBeforeRecallMs + overlapMs;
  const derived = shadow.profile.derive({
    key,
    residency: residency.state,
    queryChars: input.queryChars,
    concurrency: input.concurrency,
    overlapMs,
    laneRemainingMs: input.budgetMs > 0 ? input.budgetMs - spentMs : Infinity,
  });

  // #493: Der Provider hat für diesen Call geladen — das ist die einzige
  // Grundwahrheit über die Residenz, die es auf diesem Pfad gibt, und sie
  // gehört in den gemeinsamen Lifecycle-Zustand, nicht nur in eine Logzeile.
  //
  // #495: JEDER berichtete Ladewert, nicht nur der kalte. Ollama meldet
  // `load_duration` auch auf einem längst residenten Modell (warm gemessen
  // 0,7–2,9 ms), und dieser Wert IST der Beleg „das Modell war eben noch im
  // Speicher". Die Bedingung auf `cold_start_observed` warf ihn weg, weshalb
  // die Zeilen live weiterhin `residency_source: last-ok, estimated: true`
  // trugen — eine Schätzung neben einer vorhandenen Messung.
  if (report && report.provider_load_ms !== null) shadow.observeLoad(report.provider_load_ms);

  // #499: Hätte das gelernte Profil an dieser Stelle NOCH GEWARTET? Das ist
  // die Frage, die eine Prognose von 0 beantwortet — nicht „gäbe es einen
  // Arm". Den gibt es auf jeder Zeile, die es bis hierher schafft: Der dichte
  // Arm wird vor BM25 abgefeuert, und `http-hook-routes.ts` baut ohne ihn gar
  // keine Schattenzeile (kein Provider, offener Breaker oder `lexical_only`
  // aus #494 heißt: kein `shadowKey`, keine Zeile).
  const shadowWouldWait = derived.predicted_deadline_ms > 0;
  // Ein Arm, der gesettelt IST, ist seine eigene Gesamtzeit; nur der
  // aufgegebene braucht die späte Stichprobe (#489), und die trifft später
  // ein. Gelernt wird ausschließlich ein Arm mit echten Treffern.
  const settledInCall = !input.timedOut;
  if (settledInCall && isLatencySample(report)) {
    shadow.profile.record({
      key,
      // #499: die Residenz aus dem PROVIDERERGEBNIS, nicht die Vorab-Lesung —
      // siehe {@link sampleResidency}. Die Prognose oben steht weiter auf der
      // Vorab-Lesung, weil auf ihr entschieden wurde.
      residency: sampleResidency(residency, report?.provider_load_ms),
      queryChars: input.queryChars,
      concurrency: input.concurrency,
      totalMs: input.vectorMs,
    });
  }

  return {
    profile_key: key,
    predicted_deadline_ms: derived.predicted_deadline_ms,
    deadline_ms: input.deadlineMs,
    cap_reason: derived.cap_reason,
    basis: derived.basis,
    samples: derived.samples,
    ...(derived.expected_total_ms !== null ? { expected_total_ms: derived.expected_total_ms } : {}),
    bucket: derived.bucket,
    residency: residency.state,
    residency_source: residency.source,
    residency_estimated: residency.estimated,
    concurrency: input.concurrency,
    query_chars: input.queryChars,
    overlap_ms: overlapMs,
    lane_budget_ms: input.budgetMs,
    budget_source: input.budgetSource,
    host_profile_id: shadow.hostProfileId(),
    timed_out: input.timedOut,
    ...(report
      ? {
          provider_outcome: report.outcome,
          vector_hit_count: report.hit_count,
          cold_start_observed: report.cold_start_observed,
          ...(report.provider_load_ms !== null ? { provider_load_ms: report.provider_load_ms } : {}),
        }
      : {}),
    // Die Wirklichkeit, sofern sie schon feststeht. Beim aufgegebenen Arm steht
    // sie in der `vector_late_settle`-Zeile mit derselben `recall_id` — dort
    // trägt sie dieselbe Prognose noch einmal, damit die Auswertung ohne Join
    // auskommt.
    // #495/#499: Der Arm ist gelaufen — auf jeder Zeile, die es hierher
    // schafft. Das Feld bleibt, weil die Auswertung und die
    // `vector_late_settle`-Zeile es tragen; seine Antwort ist seit #499
    // konstant `true`, und die interessante Unterscheidung steht daneben.
    shadow_would_run: true,
    // #499: Hätte das Profil an dieser Stelle noch GEWARTET? `false` heißt:
    // Der Arm lief, aber die gelernte Politik hätte ihn nicht mehr abgewartet
    // und spät auslaufen lassen. Das war bis hierher als `shadow_would_run:
    // false` verbucht, also als „kein Arm" — und damit fielen genau die
    // `lane-too-short`-Zeilen ohne `shadow_timeout` aus Kriterium 4 aus
    // (3 von 21 der ersten Messnacht, alle drei fusioniert).
    shadow_would_wait: shadowWouldWait,
    ...(settledInCall
      ? {
          actual_settle_ms: input.vectorMs,
          // Hätte die GELERNTE Frist gehalten? Sie läuft ab demselben Nullpunkt
          // wie die Wartezeit, also ist der Vergleich genau dieser. Das ist die
          // Timeout-Quote, gegen die Kriterium 4 aus #492 die feste Zahl prüft.
          //
          // #499: Auch bei einer Prognose von 0, und dort ist der Vergleich
          // sogar besonders aussagekräftig: Er sagt, ob die gelernte Politik
          // diesen Recall verloren hätte. Für die drei Zeilen der ersten Nacht
          // (Wartezeit 6, 2 und 5 ms) lautet die Antwort `true` — sie
          // fusionierten unter der festen Zahl und hätten es unter der
          // gelernten nicht getan.
          shadow_timeout: input.waitMs > derived.predicted_deadline_ms,
        }
      : {}),
  };
}

/**
 * Die späte Stichprobe des aufgegebenen Arms — die einzige Zahl, die sagt, wie
 * lange er WIRKLICH gebraucht hätte.
 *
 * Gelernt wird die GESAMTZEIT (Überlapp + Settle): `settle_ms` misst ab dem
 * `await`, `vector_search_ms` ab dem Abfeuern, und nur die längere der beiden
 * Spannen ist mit einer im Aufruf gesettelten Stichprobe vergleichbar.
 *
 * #493: Und nur ein Arm mit echten Treffern. Ohne diese Bedingung lernte das
 * Profil aus einem Ollama, das nach 600 ms mit einem Fehler antwortet, dass
 * 600 ms ein normaler dichter Arm seien.
 */
export function recordLateSettleSample(
  shadow: DeadlineShadow,
  key: string,
  residency: ResidencyReading,
  row: DeadlineShadowRow,
  sample: LateSettleSample,
): void {
  // #495: wie oben — jeder berichtete Ladewert ist Grundwahrheit über die
  // Residenz, auch der warme.
  if (sample.provider_load_ms !== undefined && sample.provider_load_ms !== null) {
    shadow.observeLoad(sample.provider_load_ms);
  }
  // `outcome` fehlt auf Armen, deren Aufrufer keinen Beschreiber mitgab; dann
  // bleibt `settled` die einzige Aussage, und ein gescheiterter Arm ist
  // weiterhin keine Latenz.
  const usable = sample.outcome === undefined ? sample.settled : sample.outcome === "hits";
  if (!usable) return;
  shadow.profile.record({
    key,
    // #499: wie im Aufrufpfad — der Providerbeleg klassifiziert die
    // Stichprobe, nicht die Vorab-Lesung. Gerade hier zählt es doppelt: Diese
    // Zeilen sind die einzigen, die den kalten Schwanz sehen, also entscheidet
    // genau diese Stelle darüber, ob der kalte Eimer je echte kalte Daten
    // bekommt.
    residency: sampleResidency(residency, sample.provider_load_ms),
    queryChars: row.query_chars,
    concurrency: row.concurrency,
    totalMs: row.overlap_ms + sample.settle_ms,
  });
}
