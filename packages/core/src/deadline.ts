/**
 * Per-arm deadlines for recall (#342).
 *
 * The two retrieval arms have measurably different cost profiles: BM25 is an
 * in-memory MiniSearch pass, the dense arm needs a warm embedding model. #305
 * measured the gap on a real host — 734ms for the first call after the model
 * was evicted, ~161ms once resident — against a 600ms hook budget. Sharing one
 * deadline means a cold model makes the whole call miss it, and the caller gets
 * nothing at all rather than the cheap arm's answer.
 */

/**
 * Resolve with `p`'s value, or with `null` if `deadlineMs` elapses first.
 *
 * ABANDON, not abort. The pending work keeps running on purpose: the expensive
 * thing behind this deadline is usually a model load, and the call that gives
 * up on it is exactly the call that pays for it. Cancelling would re-pay the
 * cold start on every subsequent attempt and the model would never get warm.
 * The abandoned promise's result lands in whatever cache it writes to; its
 * rejection is swallowed so an abandoned arm cannot take the process down via
 * an unhandled rejection.
 *
 * `deadlineMs <= 0` disables the deadline and simply awaits `p` — the
 * pre-#342 behaviour, and the kill switch.
 *
 * `deadlineMs` reaches here from an HTTP request body (`vector_deadline_ms`,
 * clamped to [50, 10_000] in `http-hook-routes.ts` before the call) — this
 * function has no way to see that its caller already bounded it, so it
 * clamps again at the sink: no timer this function creates outlives
 * `MAX_DEADLINE_MS`, regardless of what a future caller passes.
 */
const MAX_DEADLINE_MS = 10_000;

/**
 * Die SPÄTE Stichprobe eines aufgegebenen Arms (#489).
 *
 * `settle_ms` misst ab dem Eintritt in `abandonAfter` — also ab dem echten
 * Warten des Aufrufers, derselbe Nullpunkt wie die Wartezeit, die er bezahlt
 * hat. Nur so sind die beiden Zahlen vergleichbar: „er wartete 150 ms, fertig
 * war der Arm nach 420 ms".
 *
 * Diese Zahl hat NIEMAND bezahlt. Sie trifft ein, nachdem der Aufruf längst
 * beantwortet ist, und darf deshalb nie in eine Wartezeit-Verteilung
 * einfließen — deshalb ein eigener Kanal statt eines nachträglich geänderten
 * Messwerts.
 */
export interface LateSettleSample {
  /** Dauer bis zum echten Settle, ab dem `await` in `abandonAfter`. */
  settle_ms: number;
  /** `true` = der Arm lieferte am Ende doch ein Ergebnis, `false` = er
   *  scheiterte. Ein Fehler nach dem Aufgeben ist kein Latenzwert — ein Leser
   *  muss ihn aussortieren können. */
  settled: boolean;
  /**
   * #493: das ERGEBNIS des aufgegebenen Arms, nicht nur seine Laufzeit.
   *
   * Kriterium 4 aus #492 fragt nach der kontrafaktischen Fusionsrate: „Hätte
   * die gelernte Frist gehalten?" ist nur die halbe Frage — die andere Hälfte
   * ist, ob der Arm, auf den man länger gewartet hätte, überhaupt Treffer
   * gebracht hätte. Ein Arm, der nach 900 ms mit `empty` settelt, macht keinen
   * Recall fusioniert, egal wie lang die Frist gewesen wäre.
   *
   * Kommt aus {@link LateSettleDescriber}; fehlt, wenn der Aufrufer keinen
   * mitgibt (`settled` bleibt dann die einzige Aussage, wie vor #493).
   */
  outcome?: "hits" | "empty" | "error";
  /** Treffer des Providers bei `outcome: "hits"`. */
  hit_count?: number;
  /** Vom Provider gemeldete Modell-Ladezeit dieses Calls, roh in ms. */
  provider_load_ms?: number | null;
  /** Grundwahrheit: Der Provider hat für diesen Call ein Modell geladen. */
  cold_start_observed?: boolean;
}

/**
 * #493: Übersetzt den aufgelösten Wert des späten Arms in die beschreibenden
 * Felder von {@link LateSettleSample}. `abandonAfter` ist generisch und darf
 * nichts über den Arm wissen; der Aufrufer, der den Arm gebaut hat, weiß es.
 */
export type LateSettleDescriber<T> = (value: T) => Omit<LateSettleSample, "settle_ms" | "settled">;

export async function abandonAfter<T>(
  p: Promise<T>,
  deadlineMs: number,
  onLateSettle?: (sample: LateSettleSample) => void,
  describeLate?: LateSettleDescriber<T>,
): Promise<T | null> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return p;
  const clampedMs = Math.min(deadlineMs, MAX_DEADLINE_MS);
  const startedAt = Date.now();

  // The loser of this race is still live. Without this handler, a later
  // rejection on an abandoned arm would surface as an unhandled rejection —
  // fatal in Node by default, and this runs inside short-lived hook processes.
  p.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), clampedMs);
    // Never hold the event loop open on this timer's account. A hook CLI that
    // finished its work must be free to exit; an un-unref'd timer would keep
    // the process alive for the remainder of the deadline.
    timer.unref?.();
  });

  try {
    const winner = await Promise.race([p, expiry]);
    // #489: Nur der aufgegebene Arm hat eine späte Stichprobe. Bis hierher ist
    // `vector.search` die einzige Zahl des dichten Arms gewesen — und beim
    // Timeout stand dort die Deadline, nicht das Settle. Eine Verteilung aus
    // solchen Werten lernt die Grenze, die schon gilt.
    //
    // Die Fortsetzung hängt an der WEITERLAUFENDEN Promise (siehe oben: wir
    // brechen bewusst nicht ab). Sie hält den Prozess nicht offen — eine
    // Fortsetzung an einer Promise ist kein Handle; offen hält ihn allein die
    // Arbeit dahinter, die ohnehin schon lief. Ein neuer Timer entsteht hier
    // NICHT; der einzige der Funktion wird im `finally` gelöscht.
    //
    // Zwei getrennte Handler statt `finally`: Der Fehlerfall muss als solcher
    // gemeldet werden. Der `p.catch()` oben schluckt die Ablehnung weiterhin,
    // diese Kette fügt keine unbehandelte hinzu — und ein werfender Listener
    // wird hier abgefangen, sonst würde genau er die unbehandelte Ablehnung
    // erzeugen, die der Handler oben verhindern soll.
    if (winner === null && onLateSettle) {
      const report = (settled: boolean, value?: T): void => {
        try {
          // #493: Der Beschreiber läuft INNERHALB desselben try — ein
          // werfender Beschreiber darf so wenig eskalieren wie ein werfender
          // Listener, und die Zeile geht dann eben ohne Ergebnisfelder raus.
          const detail =
            settled && describeLate && value !== undefined ? describeLate(value) : {};
          onLateSettle({ settle_ms: Date.now() - startedAt, settled, ...detail });
        } catch {
          /* Telemetrie darf einen aufgegebenen Arm nie zum Absturz bringen */
        }
      };
      p.then(
        (value) => report(true, value),
        () => report(false),
      );
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
