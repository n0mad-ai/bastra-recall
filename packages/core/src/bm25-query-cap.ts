/**
 * Längen-Cap für den LEXIKALISCHEN Arm (#362).
 *
 * `normalizeQuery` (query-normalize.ts) deckelt auf 8000 Zeichen — reine
 * hostile-input defense. Der Cap hier ist etwas anderes: ein Kosten-Knob.
 * MiniSearchs Suchzeit ist linear in der Zahl der Query-Terme (jeder Term ist
 * ein eigener Trie-Walk plus prefix/fuzzy-Expansion), und die Hook-Lanes
 * schicken den ganzen Prompt als Query. Gemessen auf einem 968-Memory-Vault
 * (#362, `recall_stages.bm25_search_ms`, n=1325):
 *
 * ```
 * Query-Terme (Median)   4     41    147    1001   2403
 * bm25_search_ms         9     84    178     454    741
 * ```
 *
 * Der Dense-Arm liegt in denselben Bändern konstant bei 104–153 ms. Der
 * lexikalische Arm ist also das, was das 200-ms-Budget von #305 reißt, und er
 * reißt es an der Query-LÄNGE, nicht an der Vault-Größe.
 *
 * Warum nicht einfach vorne abschneiden: ein Prompt fängt mit Höflichkeiten,
 * Rahmen und Wiederholung an und trägt seine diskriminierenden Wörter irgendwo
 * in der Mitte („`NSHostingController.sizingOptions`", „`abandonAfter`",
 * „SIGKILL"). Präfix-Trunkierung kappt genau das BM25-Signal und behält den
 * Rauschanteil — und BM25 gewichtet über IDF ohnehin die seltenen Terme.
 * Deshalb wird nach Seltenheit AUSGEWÄHLT: Document-Frequency aus dem
 * bestehenden Index (`DocFreqMiniSearch.docFreq`), aufsteigend, bis das Budget
 * voll ist. Ohne DF-Quelle bleibt Präfix als Fallback — Kosten-Cap greift
 * dann trotzdem.
 */
import { capAtWordBoundary, tokenizeWithIdentifiers } from "./query-normalize.js";

/** Zeichen-Budget für den BM25-Arm. 200 aus #362: das 100–200-Zeichen-Band
 *  liegt bei bm25 p50 46 ms / p90 61 ms und passt damit neben den ~140 ms
 *  Dense-Arm unter das 200-ms-Ziel von #305. */
export const BM25_QUERY_MAX_CHARS = 200;

/** Term-Budget. Zweite Dimension, weil Zeichen die Kosten nur ungenau
 *  abbilden: `a b c d e …` ist kurz und teuer, ein einzelner Dateipfad lang
 *  und billig. ~32 Terme entsprechen dem 41-Term-Band (84 ms) nach unten hin. */
export const BM25_QUERY_MAX_TERMS = 32;

/** Document-Frequency eines Index-Terms; `0` = im Index nicht vorhanden. */
export type DocFreqFn = (term: string) => number;

export interface Bm25QueryCap {
  /** Zeichen-Budget. `0` oder nicht-endlich = Cap aus (Verhalten vor #362). */
  maxChars?: number;
  /** Term-Budget nach Tokenizer-Emission (Dual-Emission zählt mit). */
  maxTerms?: number;
}

interface Candidate {
  /** Wort wie im Original (Identifier bleiben byte-identisch). */
  word: string;
  /** Position im Original — stabile Tie-Break- und Ausgabe-Ordnung. */
  index: number;
  /** Zahl der Terme, die MiniSearchs Tokenizer aus dem Wort emittiert.
   *  Dual-Emission (#162): `my-app.config.ts` sind 4 Terme, nicht 1. */
  termCount: number;
  /** Kleinste DF unter den emittierten Termen, `null` wenn keiner im Index
   *  steht. Das Minimum, weil der zusammenhängende Identifier der seltenste
   *  und stärkste der emittierten Terme ist — er bestimmt den Wert des Worts. */
  minDf: number | null;
}

/**
 * Kappt `query` für den BM25-Arm auf `maxChars`/`maxTerms`, indem die
 * seltensten Wörter behalten werden. Pure, wirft nie, idempotent (das Ergebnis
 * ist ≤ maxChars und läuft deshalb in den Fast-Path).
 *
 * Erwartet eine bereits `normalizeQuery`-te Query (kollabiertes Whitespace);
 * arbeitet aber auf jedem Input korrekt.
 *
 * Ohne `docFreq` — oder wenn die Auswahl leer bliebe — Fallback auf
 * `capAtWordBoundary`, also Präfix. Schlechter für die Trefferqualität, aber
 * nie schlechter als heute in Kosten.
 */
export function capBm25Query(query: string, docFreq?: DocFreqFn, opts: Bm25QueryCap = {}): string {
  const maxChars = opts.maxChars ?? BM25_QUERY_MAX_CHARS;
  const maxTerms = opts.maxTerms ?? BM25_QUERY_MAX_TERMS;
  // Kill-Switch, gleiche Konvention wie `vector_deadline_ms` in `abandonAfter`:
  // 0 (oder nicht-endlich) heißt „kein Cap", also das Verhalten vor #362. Der
  // Vergleich gekappt/ungekappt ist damit über die normale API messbar, statt
  // nur über einen Nachbau des Index.
  if (!Number.isFinite(maxChars) || maxChars <= 0) return query;
  // Fast-Path: die überwiegende Mehrheit der Queries ist kurz (gemessen:
  // 1398 von 1545 Calls unter 200 Zeichen). Kein Tokenizer-Lauf, keine
  // Allokation, byte-identische Query — und damit garantiert unverändertes
  // Verhalten für alles, was heute schon im Budget liegt.
  if (query.length <= maxChars) return query;
  if (!docFreq) return capAtWordBoundary(query, maxChars);

  const candidates = collectCandidates(query, docFreq);
  if (candidates.length === 0) return capAtWordBoundary(query, maxChars);

  // Seltenste zuerst. Wörter ohne jeden Index-Term (`minDf === null`) landen
  // hinten, nicht vorne: naive IDF würde sie für maximal selten halten, dabei
  // tragen sie kein BM25-Gewicht (nur noch prefix/fuzzy) und sind pro Term das
  // Teuerste, was man kaufen kann. Sie füllen nur auf, was das Budget übrig
  // lässt — die Fuzzy-Toleranz gegen Tippfehler bleibt damit erhalten,
  // verdrängt aber keinen echten Treffer-Term.
  const ranked = [...candidates].sort((a, b) => {
    if (a.minDf === null || b.minDf === null) {
      if (a.minDf !== b.minDf) return a.minDf === null ? 1 : -1;
      return a.index - b.index;
    }
    if (a.minDf !== b.minDf) return a.minDf - b.minDf;
    return a.index - b.index;
  });

  const picked: Candidate[] = [];
  let chars = 0;
  let terms = 0;
  for (const c of ranked) {
    if (terms >= maxTerms || chars >= maxChars) break;
    const cost = c.word.length + (picked.length > 0 ? 1 : 0); // + Trenn-Space
    // Überspringen statt abbrechen: die Restliste ist nach Seltenheit
    // sortiert, ein langes Wort darf die kürzeren dahinter nicht blockieren.
    if (chars + cost > maxChars || terms + c.termCount > maxTerms) continue;
    picked.push(c);
    chars += cost;
    terms += c.termCount;
  }
  if (picked.length === 0) return capAtWordBoundary(query, maxChars);

  // Ausgabe in Original-Reihenfolge. Für BM25 mit `combineWith: "OR"` ist die
  // Reihenfolge bedeutungslos; sie hält aber Query-Cache-Keys, Telemetrie und
  // Test-Assertions deterministisch und lesbar.
  picked.sort((a, b) => a.index - b.index);
  return picked.map((c) => c.word).join(" ");
}

/** Distinkte Wörter der Query mit Term-Zahl und minimaler DF. */
function collectCandidates(query: string, docFreq: DocFreqFn): Candidate[] {
  const out: Candidate[] = [];
  // Dedup über die gefaltete Form: ein Prompt wiederholt seine Schlüsselwörter,
  // und ein zweites Vorkommen kostet in MiniSearch einen weiteren Trie-Walk,
  // ohne die Rangfolge zu ändern (derselbe Term, derselbe Score-Beitrag —
  // addiert, aber für alle Kandidaten gleichmäßig).
  const seen = new Set<string>();
  let i = 0;
  for (const word of query.split(/\s+/)) {
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const emitted = tokenizeWithIdentifiers(word);
    // Reine Punktuation („—", „…", „|") emittiert keinen Term und ist für
    // BM25 folgenlos.
    if (emitted.length === 0) continue;
    let minDf: number | null = null;
    for (const term of emitted) {
      const df = docFreq(term);
      if (df > 0 && (minDf === null || df < minDf)) minDf = df;
    }
    out.push({ word, index: i++, termCount: emitted.length, minDf });
  }
  return out;
}
