/**
 * Der Suchmodus-Router (#362, Phase 2) — vorerst als SCHATTEN.
 *
 * Vier Betriebsarten, weil eine einzige nicht beides kann: die exakte
 * Bezeichnersuche, die BM25 braucht, und das 200-ms-Budget, das der volle
 * lexikalische Arm auf langen Prompts reißt. Welche greift, entscheidet nicht
 * die Promptlänge, sondern was die Suche kosten wird und ob ein dichter Arm
 * überhaupt verfügbar ist.
 *
 * ```
 * dicht verfügbar?
 * ├─ ja, lexikalisch billig   → hybrid            (heutiges Verhalten)
 * ├─ ja, lexikalisch teuer    → dense-primary     (+ exakte Identifier-Rettung)
 * └─ nein
 *    ├─ lexikalisch billig    → lexical-full      (voller BM25, mit Fuzzy)
 *    └─ lexikalisch teuer     → lexical-fast      (exact/prefix, Fuzzy gezielt)
 * ```
 *
 * **Warum Schatten:** Drei der vier Modi ändern das Ranking, und die
 * Einblendschwelle sitzt auf einem rangabgeleiteten Score — dieselbe Falle, an
 * der Query-Cap und Fuzzy-Steuerung schon gescheitert sind. Der Router
 * berechnet seine Entscheidung deshalb, schreibt sie in die Telemetrie und
 * ändert nichts. Erst wenn ein gelabeltes Qualitätsset zeigt, dass ein Modus
 * den `required`-Recall hält, darf er scharf geschaltet werden. Bis dahin ist
 * die Schattenspalte die Datengrundlage genau dieser Entscheidung: Sie sagt,
 * wie oft welcher Modus GEGRIFFEN HÄTTE und was das gekostet hätte.
 */
import { lexicalFitsBudget, estimateBm25Ms } from "./query-cost.js";

export type RetrievalMode = "hybrid" | "dense-primary" | "lexical-full" | "lexical-fast";

export interface RouteInput {
  /** Eindeutige Terme nach der Gruppierung — der Kostentreiber. */
  uniqueTerms: number;
  /** Steht ein dichter Arm zur Verfügung (Embeddings an, Breaker zu)? */
  denseAvailable: boolean;
  /** Budget der aufrufenden Lane in ms; `0` = kein Budget. */
  budgetMs: number;
  /** Was der dichte Arm vom Budget beansprucht (seine Deadline). */
  denseReservedMs: number;
}

export interface RouteDecision {
  mode: RetrievalMode;
  /** Geschätzte Kosten des vollen lexikalischen Arms in ms. */
  estimatedLexicalMs: number;
  /** Hätte der volle lexikalische Arm ins Budget gepasst? */
  lexicalFits: boolean;
}

/**
 * Entscheidet den Modus. Rein rechnerisch, ohne I/O — der Aufrufer kann sie
 * vor jeder Suche stellen, ohne dafür zu bezahlen.
 *
 * Ohne dichten Arm ist `lexical-fast` kein Komfort, sondern die einzige
 * Möglichkeit, überhaupt zu antworten: Auf einer Maschine ohne Embeddings gibt
 * es nichts, wohin die teure Arbeit ausgelagert werden könnte.
 */
export function routeRetrieval(input: RouteInput): RouteDecision {
  const estimatedLexicalMs = estimateBm25Ms(input.uniqueTerms);
  const fits = lexicalFitsBudget(
    input.uniqueTerms,
    input.budgetMs,
    input.denseAvailable ? input.denseReservedMs : 0,
  );
  const mode: RetrievalMode = input.denseAvailable
    ? fits
      ? "hybrid"
      : "dense-primary"
    : fits
      ? "lexical-full"
      : "lexical-fast";
  return { mode, estimatedLexicalMs, lexicalFits: fits };
}
