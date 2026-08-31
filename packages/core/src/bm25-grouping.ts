/**
 * Rangneutrale Termgruppierung für den lexikalischen Arm (#362, Phase 1).
 *
 * MiniSearch sucht jeden Query-Term einzeln: ein Trie-Walk plus prefix- und
 * fuzzy-Expansion, pro Vorkommen. Ein langer Prompt wiederholt aber die Hälfte
 * seiner Wörter — gemessen 1186 emittierte gegen 649 eindeutige Terme im
 * Median. Die zweite Hälfte der Arbeit ist also reine Wiederholung.
 *
 * Sie zu streichen ist nur dann folgenlos, wenn das GEWICHT der Wiederholung
 * erhalten bleibt: In BM25 zählt ein dreimal gestellter Term dreifach. Genau
 * dafür gibt es `boostTerm` — jeder eindeutige Term wird einmal gesucht und mit
 * seiner Häufigkeit multipliziert.
 *
 * **Die Reihenfolge entscheidet, ob das stimmt.** Gezählt werden muss NACH
 * MiniSearchs `processTerm` (Default: `toLowerCase`), nicht davor. Sonst sind
 * `Recall` und `recall` zwei Einträge, die Häufigkeiten verteilen sich falsch,
 * und das Ergebnis weicht ab. Gemessen auf 30 echten Prompts gegen den echten
 * Vault:
 *
 * ```
 * gruppiert VOR  processTerm :  0/30 identische Ranglisten, Abweichung 2,55e+6
 * gruppiert NACH processTerm : 30/30 identische Ranglisten, Abweichung 1,77e-8
 * ```
 *
 * 1,77e-8 ist Float-Rundung aus der geänderten Additionsreihenfolge, mehr
 * nicht. Die Latenz fällt dabei von 1100 auf 441 ms p50 (p90 1602 → 622).
 *
 * Der zweite Stolperstein ist der Identifier-Tokenizer (#162): Er emittiert
 * `my-app.config.ts` als vollen Identifier UND als `my`/`app`/`config`/`ts`.
 * Baut man die gruppierte Query als String zusammen, zerlegt MiniSearch den
 * vollen Identifier ein zweites Mal — die Häufigkeiten stimmen dann wieder
 * nicht. Deshalb bekommt der gruppierte Aufruf einen Identitäts-Tokenizer:
 * Die Query IST bereits die Termliste.
 */

/** Was `MiniSearch.search()` für den gruppierten Aufruf braucht. */
export interface GroupedQuery {
  /** Die eindeutigen Terme, durch Leerzeichen getrennt. */
  query: string;
  /** Vorkommen je Term — die Multiplikatoren für `boostTerm`. */
  counts: Map<string, number>;
  /** Emittierte Terme insgesamt (vor der Gruppierung), für Telemetrie. */
  emitted: number;
}

/**
 * Zerlegt die Query mit dem PRODUKTIVEN Tokenizer, faltet mit `processTerm`
 * und zählt danach.
 *
 * `tokenize` und `processTerm` müssen dieselben Funktionen sein, mit denen der
 * Index gebaut wurde — werden sie es nicht, sucht der gruppierte Arm nach
 * Termen, die im Trie nicht stehen, und findet still weniger.
 */
export function groupQueryTerms(
  query: string,
  tokenize: (text: string) => string[],
  processTerm: (term: string) => string = (t) => t.toLowerCase(),
): GroupedQuery {
  const terms = tokenize(query);
  const counts = new Map<string, number>();
  for (const raw of terms) {
    const t = processTerm(raw);
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return { query: [...counts.keys()].join(" "), counts, emitted: terms.length };
}

/** Identitäts-Tokenizer für den gruppierten Aufruf: die Query ist die Liste. */
export const groupedTokenize = (s: string): string[] => (s === "" ? [] : s.split(" "));
