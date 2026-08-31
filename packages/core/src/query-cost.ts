/**
 * Kostenschätzung für den lexikalischen Arm (#362, Phase 2).
 *
 * Der Router muss VOR der Suche entscheiden, ob der volle BM25-Arm ins Budget
 * passt. Die naheliegende Größe — die Zeichenzahl des Prompts — ist dafür ein
 * schlechter Stellvertreter: Ein 2000-Zeichen-Stacktrace mit lauter
 * eindeutigen Pfaden ist teurer als 4000 Zeichen Fließtext, der die Hälfte
 * seiner Wörter wiederholt. Gemessen an genau diesem Fall: derselbe Prompt hat
 * 502 emittierte, aber nur 25 eindeutige Terme — die Kosten folgen der zweiten
 * Zahl.
 *
 * Was hier geschätzt wird, ist deshalb die Zahl der EINDEUTIGEN Terme nach der
 * Gruppierung, multipliziert mit dem gemessenen Preis pro Term. Die Bänder aus
 * #362, umgerechnet auf den gruppierten Arm (30 echte Prompts, 991 Memories):
 *
 * ```
 * eindeutige Terme (Median)   25    613
 * bm25_search_ms              43    461
 * ```
 *
 * Das sind ~0,75 ms pro eindeutigem Term, mit einem kleinen Sockel. Bewusst
 * eine gerade Linie und kein gelerntes Modell: Die Schätzung entscheidet, ob
 * ein Budget reicht, nicht wie ein Ranking aussieht. Sie darf grob sein, sie
 * darf sich irren — sie muss nur monoton in der Größe sein, die die Kosten
 * wirklich treibt, und sie muss ohne Suche auskommen.
 *
 * Kalibriert wird sie über die Telemetrie: `recall_stages.terms_unique` gegen
 * `recall_stages.bm25_search_ms` derselben Events. Weichen die Werte auf einer
 * anderen Maschine systematisch ab, gehören die beiden Konstanten angepasst —
 * dafür stehen sie hier einzeln und benannt.
 */

/** Sockel je Aufruf (Tokenisierung, Aufbau, Sortierung) in ms. */
export const BM25_COST_BASE_MS = 8;

/** Grenzkosten je EINDEUTIGEM Query-Term in ms, auf dem gruppierten Arm. */
export const BM25_COST_PER_UNIQUE_TERM_MS = 0.75;

/**
 * Geschätzte Laufzeit des vollen lexikalischen Arms in ms.
 *
 * `uniqueTerms` kommt aus `groupQueryTerms()` — die Gruppierung läuft ohnehin
 * vor jeder Suche, die Zahl ist also kostenlos zu haben und beschreibt exakt
 * die Arbeit, die danach ansteht.
 */
export function estimateBm25Ms(uniqueTerms: number): number {
  return BM25_COST_BASE_MS + uniqueTerms * BM25_COST_PER_UNIQUE_TERM_MS;
}

/**
 * Passt der volle lexikalische Arm in das Budget?
 *
 * **Die Arme überlappen — sie addieren sich nicht.** Der dichte Arm wird VOR
 * BM25 abgesendet (`search.ts`), läuft also währenddessen beim Provider. Die
 * Wanduhr eines Aufrufs ist damit `max(BM25, Dense)` plus etwas Overhead, nicht
 * die Summe. Gemessen über vier Aufrufe (BM25 / Vector-Stage / Gesamt):
 *
 * ```
 * 644 / 646 / 651   →  Gesamt − max = 5 ms
 *  43 / 154 / 161   →                 7 ms
 *  13 /  84 /  87   →                 3 ms
 *   5 /  76 /  79   →                 3 ms
 * ```
 *
 * Die erste Fassung zog die Dense-Reserve vom Budget ab und ließ BM25 damit nur
 * 50 der 200 ms — das hätte den Router im interessanten Mittelfeld unnötig früh
 * auf `dense-primary` geschickt und dort lexikalische Qualität verschenkt, für
 * eine Zeit, die gar nicht anfällt.
 *
 * Achtung bei der Interpretation der Vector-Stage: Sie misst von Absenden bis
 * Verarbeiten, nicht die Modellarbeit. Solange BM25 den Event Loop hält, kann
 * Node ein längst fertiges Ollama-Ergebnis nicht entgegennehmen — die 646 ms
 * oben sind überwiegend Wartezeit auf den lexikalischen Arm, keine Rechenzeit.
 */
export function lexicalFitsBudget(
  uniqueTerms: number,
  budgetMs: number,
  denseReservedMs: number,
): boolean {
  if (budgetMs <= 0) return true; // kein Budget gesetzt = keine Beschränkung
  const lexical = estimateBm25Ms(uniqueTerms);
  // Der teurere Arm bestimmt die Wanduhr; der dichte kostet nur dann etwas
  // zusätzlich, wenn er länger braucht als der lexikalische.
  const wallClock = Math.max(lexical, denseReservedMs) + OVERLAP_OVERHEAD_MS;
  return wallClock <= budgetMs;
}

/** Was neben `max(BM25, Dense)` an Fusion, Dämpfung und Sortierung anfällt.
 *  Gemessen 3–7 ms über die vier Aufrufe oben; konservativ die Obergrenze. */
export const OVERLAP_OVERHEAD_MS = 7;
