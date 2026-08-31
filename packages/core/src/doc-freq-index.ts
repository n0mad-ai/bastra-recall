/**
 * MiniSearch mit lesbarer Document-Frequency (#362).
 *
 * Der BM25-Query-Cap muss die Query-Terme nach Seltenheit sortieren, sonst
 * kappt er das Signal statt der Füllwörter (siehe `bm25-query-cap.ts`).
 * Seltenheit heißt hier: Document-Frequency aus dem Index, der ohnehin schon
 * gebaut ist — keine zweite Datenstruktur, kein zweiter Tokenizer-Lauf, keine
 * Persistenz.
 *
 * MiniSearch exportiert dafür keine öffentliche API, hält den Postings-Trie
 * aber als `protected _index` — für eine Unterklasse also legal erreichbar.
 * Bewusst eine Unterklasse und KEIN `as any`-Cast: verschwindet oder
 * umbenennt sich das Feld in einer künftigen MiniSearch-Version, bricht der
 * Compile, nicht die Relevanz zur Laufzeit.
 */
import MiniSearch from "minisearch";

export class DocFreqMiniSearch<T = unknown> extends MiniSearch<T> {
  /**
   * Wie verbreitet ist `term` im Index? Größer = häufiger = weniger
   * diskriminierend. `0` heißt „im Index nicht vorhanden" — was für den
   * Cap-Aufrufer NICHT „maximal selten" bedeutet, sondern „trägt kein
   * BM25-Gewicht" (nur noch prefix/fuzzy-Expansion, und die ist der teuerste
   * Teil der Suche).
   *
   * Der Wert ist die Summe der Document-Frequencies über alle Felder, nicht
   * die Zahl der distinkten Dokumente: ein Term in Title UND Body desselben
   * Memory zählt 2. Bewusst — für eine reine Seltenheits-ORDNUNG genügt das,
   * ist monoton in der echten DF und kostet O(#Felder) statt O(#Dokumente)
   * pro Term. Für einen echten IDF-Wert wäre es zu grob.
   *
   * Lowercasing hier, weil der Index mit MiniSearchs Default-`processTerm`
   * (`term.toLowerCase()`) gebaut wird — ein ungefalteter Term würde im Trie
   * schlicht fehlen und wäre fälschlich „selten".
   */
  docFreq(term: string): number {
    const perField = this._index.get(term.toLowerCase());
    if (!perField) return 0;
    let total = 0;
    for (const docs of perField.values()) total += docs.size;
    return total;
  }
}
