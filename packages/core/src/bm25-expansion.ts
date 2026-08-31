/**
 * Fuzzy-Expansion nach Seltenheit für den LEXIKALISCHEN Arm (#362).
 *
 * Der Längen-Cap (`bm25-query-cap.ts`) ging von der falschen Ursache aus. Er
 * nahm an, die BM25-Zeit hänge an der ZAHL der Query-Terme, und kürzte deshalb
 * die Query — womit er Dokumente aus dem Kandidatenraum entfernt. Der
 * Akzeptanzlauf hat ihn genau daran scheitern lassen: 200 Zeichen verloren auf
 * 15/15 Queries injektionsrelevante Ids.
 *
 * Gemessen auf dem echten Vault (986 Memories, 12 Queries à ~4,4k Zeichen,
 * Produktionsgewichte, KEIN Term entfernt — nur die MiniSearch-Optionen
 * variiert):
 *
 * ```
 * Variante                                     Median ms   A-Top10 in Top50
 * prefix+fuzzy für alle Terme (Produktion)          540           100 %
 * prefix, kein fuzzy                                280           100 %
 * prefix alle, fuzzy nur für seltene Terme          238           100 %
 * nur exakte Terme                                   78            94 %
 * ```
 *
 * Die Zeit steckt also in der EXPANSION, nicht in der Termzahl: Jeder Term
 * kostet einen Trie-Walk über das Vokabular, und die billigsten Wörter eines
 * langen Prompts — Füllwörter — sind zugleich die, deren Fuzzy-Nachbarschaft
 * am größten ist und am wenigsten trägt. Ein häufiges Wort braucht keine
 * Tippfehler-Toleranz: Es steht ohnehin in halben Vault, und sein IDF-Gewicht
 * ist entsprechend klein. Ein seltenes Wort ist der Grund, warum die Query
 * überhaupt etwas findet — dort ist Fuzzy sein Geld wert.
 *
 * Der entscheidende Unterschied zum Cap: Hier wird kein Term entfernt. Jeder
 * Term sucht weiter exakt und mit Präfix; nur die Fuzzy-Nachbarschaft der
 * häufigen Terme entfällt. Deshalb schrumpft der Kandidatenraum nicht — die
 * Reihenfolge innerhalb der Top-10 verschiebt sich, aber alles, was die
 * Produktion vorne hatte, bleibt in der Tiefe, in der RRF und der Pool
 * (`onCandidatePool`) greifen.
 */

/** Document-Frequency eines Index-Terms; `0` = im Index nicht vorhanden. */
export type DocFreqFn = (term: string) => number;

/**
 * DF-Schwelle, ab der ein Term als „häufig" gilt und seine Fuzzy-Expansion
 * entfällt. 40 von 986 Dokumenten (≈ 4 %) aus der Messung oben.
 *
 * Der Wert ist absichtlich eine Konstante und kein Anteil der Vault-Größe: Die
 * Kosten, die er begrenzt, hängen an der Größe der Fuzzy-Nachbarschaft im
 * Vokabular, nicht an der Dokumentzahl. Ein Vault, der auf 5000 Memories
 * wächst, bekommt nicht automatisch längere Wörter.
 */
export const BM25_FUZZY_RARE_DF_MAX = 40;

/** Fuzzy-Wert der Produktion, wenn expandiert wird. */
export const BM25_FUZZY = 0.2;

/**
 * Baut die `fuzzy`-Option für `MiniSearch.search()`.
 *
 * `maxDf` unset, `0` oder nicht-endlich → `undefined`: Der Aufrufer hängt dann
 * nichts an und es gilt das im Index konfigurierte Verhalten (Fuzzy für alle
 * Terme). Das ist der Default und exakt das Verhalten vor #362.
 *
 * Ein Term mit DF `0` steht nicht im Index. Für ihn ist Fuzzy der EINZIGE Weg,
 * überhaupt etwas zu treffen — ein Tippfehler oder eine Flexionsform trifft
 * nur über die Nachbarschaft. Er wird deshalb wie ein seltener Term behandelt,
 * nicht wie ein häufiger.
 */
export function rareTermFuzzy(
  docFreq: DocFreqFn,
  maxDf: number | undefined,
): ((term: string) => number | false) | undefined {
  if (maxDf === undefined || !Number.isFinite(maxDf) || maxDf <= 0) return undefined;
  return (term: string) => {
    const df = docFreq(term);
    return df === 0 || df <= maxDf ? BM25_FUZZY : false;
  };
}
