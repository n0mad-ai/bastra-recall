/**
 * Evidenz am BM25-Treffer (#1039): Hat ein Query-Term exakt auf einem
 * hand-geschriebenen Trigger gematcht (`matchedRecallWhen`), und wie tragfähig
 * ist dieser Anker (`anchorStrength`)? Beide laufen pro Treffer auf dem
 * BM25- und dem Hybrid-Pfad von `SearchIndex` (search.ts); der Zustand, den
 * sie brauchen (recall_when-DF, Phrasen aus dem Vault), kommt als Argument.
 */
import { tokenizeWithIdentifiers } from "./query-normalize.js";
import { PHRASE_STOPWORDS, MIN_SIGNIFICANT_TOKEN_LEN } from "./stopwords.js";

/**
 * Hat ein Query-Term EXAKT auf dem hand-geschriebenen `recall_when_flat`
 * gematcht?
 *
 * MiniSearch `match` ist `{ term: fields[] }`, wobei `term` der **Dokument**-
 * Term ist, nicht der Query-Term — bei einem Prefix- oder Fuzzy-Treffer stehen
 * dort Wörter, die in der Query gar nicht vorkommen. Die frühere Fassung fragte
 * nur, ob irgendein solcher Term im Trigger-Feld lag, und beantwortete damit
 * eine andere Frage als die, für die das Flag existiert.
 *
 * Der Unterschied ist keine Feinheit: Das Flag bedeutet „der Autor hat GENAU
 * diesen Kontext als Auslöser deklariert" und schaltet daran zwei Dinge frei —
 * den Cross-Scope-Bypass (`hook-skip.ts`) und die Unterdrückung von
 * `weak_result` (`weak-result.ts`). Beides sind Aussagen über Absicht, und
 * Absicht lässt sich nicht aus einer Tippfehler-Nachbarschaft ableiten:
 * gemessen setzte `obsidan` (ein Edit) und `tripwir` (ein Präfix) das Flag auf
 * Memories, deren Trigger diese Wörter nie enthielten.
 *
 * Deshalb zählt ab jetzt nur, was auch in der Query steht. `queryTerms` sind
 * die produktiv tokenisierten, gefalteten Terme der Query; ist das Set leer
 * (kein Caller-Kontext), bleibt das Flag false — lieber ein Anker zu wenig als
 * einer, der Absicht behauptet, die es nicht gibt.
 *
 * `recall_when_expanded_flat` zählt weiterhin NICHT: doc2query-generiert, vom
 * Autor nicht als Trigger geschrieben (#148).
 */
export function matchedRecallWhen(
  r: { match?: Record<string, string[]> },
  queryTerms: ReadonlySet<string>,
): boolean {
  const match = r.match;
  if (!match || queryTerms.size === 0) return false;
  for (const [term, fields] of Object.entries(match)) {
    if (fields.includes("recall_when_flat") && queryTerms.has(term.toLowerCase())) return true;
  }
  return false;
}

/**
 * Wie TRAGFÄHIG ist der Anker? (P0, Punkt 6.)
 *
 * `matched_recall_when` sagt nur, DASS ein Query-Term wörtlich in einer
 * autorisierten Triggerphrase stand. Für Telemetrie genügt das; für die eine
 * Entscheidung, die daran am teuersten hängt, nicht: Ein Memory aus einem
 * FREMDEN Projekt darf sich in diese Session drängen (`hook-skip.ts`).
 *
 * **Was `strong` verlangt** — dieselbe Regel, die der Reflex-Pfad seit dem
 * 20.08.-Vorfall anwendet (`reflex.ts`):
 *
 *  - zwei signifikante exakte Terme aus **derselben** authored Phrase, oder
 *  - ein exakter Term, der wie ein Bezeichner aussieht UND im Vault selten ist.
 *
 * „Derselben Phrase" ist der Punkt, an dem die erste Fassung zu schwach war:
 * Sie zählte Treffer über das flach zusammengefügte `recall_when_flat`, also
 * quer über alle Phrasen eines Memories. Ein Memory mit zehn Triggern sammelt
 * so leicht zwei zufällige Wörter aus zwei unabhängigen Situationen ein — was
 * keine Absichtserklärung ist, sondern Statistik. Deshalb kommen die Phrasen
 * hier einzeln aus dem Vault.
 *
 * #360: die erste Fassung dieser Funktion hatte drei weitere Lücken.
 *
 * 1. Sie zählte EMISSIONEN, nicht distinkte Wörter — `"foo bei foo"` mit
 *    Query `foo` traf den Rohtoken-Strom zweimal (zwei Positionen, gleiches
 *    Wort) und wurde `strong`, und ein einzelnes `my-app` (Dual-Emission zu
 *    `my-app`, `my`, `app`) füllte die Zweierregel allein. Jetzt wird pro
 *    Phrase WORTWEISE gesplittet (am Whitespace) und je Wort nur EINMAL in
 *    ein `Set` eingetragen — Wiederholungen desselben Wortes und mehrere
 *    Emissionen eines einzelnen Wortes zählen beide als „ein Ursprung".
 * 2. Zwei x-beliebige Terme reichten, auch wenn beide Allerweltswörter waren.
 *    `isSignificantTriggerTerm` filtert jetzt Funktionswörter (geteilte Liste
 *    mit dem Reflex-Pfad, `stopwords.ts`) und Kurzwörter unter
 *    `MIN_SIGNIFICANT_TOKEN_LEN` heraus, bevor ein Wort zur Zweierregel
 *    beiträgt.
 * 3. Die Seltenheit lief über `DocFreqMiniSearch.docFreq()` — Summe über ALLE
 *    SIEBEN Felder, nicht über distinkte Memories mit dem Term in
 *    `recall_when`. Ein Term, der nur in einem authored Trigger, aber in
 *    zehn Bodies steht, riss die Schwelle künstlich. `recallWhenDocFreq`
 *    (siehe `SearchIndex`) zählt jetzt genau das Gefragte. Zusätzlich lief
 *    die Identifier-Prüfung auf dem bereits GEFALTETEN Term — camelCase war
 *    zu diesem Zeitpunkt strukturell unsichtbar. Beide Einzelterm-Checks
 *    laufen jetzt auf der ROHEN (ungefalteten) Phrase aus dem Vault; gefaltet
 *    wird nur für den Set-Vergleich gegen die gematchten Query-Terme.
 *
 * **Zur Seltenheitsschwelle, offen gesagt:** Sie ist nicht kalibriert, weil es
 * dafür noch keine Labels gibt. Der Wert `5` ist unverändert — er war nie zu
 * hoch, er wurde nur gegen die falsche (zu große) DF gemessen; siehe Punkt 3.
 *
 * Der Preis ist ein bewusster: Eine legitime Cross-Project-Erinnerung, die an
 * einem einzelnen natürlichen Wort hängt, kommt nicht mehr durch. Bei einem
 * Bypass ist dieser Fehler die billigere Richtung — ein themenfremdes REQUIRED
 * kostet Kontext und Vertrauen, ein fehlender Hinweis nur eine Nachfrage.
 */
export function anchorStrength(
  r: { id: unknown; match?: Record<string, string[]> },
  queryTerms: ReadonlySet<string>,
  recallWhenDocFreq: (term: string) => number,
  phrasesOf: (id: string) => string[],
): "strong" | "weak" | undefined {
  const match = r.match;
  if (!match || queryTerms.size === 0) return undefined;

  const matchedTriggerTerms = new Set<string>();
  for (const [term, fields] of Object.entries(match)) {
    const folded = term.toLowerCase();
    if (fields.includes("recall_when_flat") && queryTerms.has(folded)) {
      matchedTriggerTerms.add(folded);
    }
  }
  if (matchedTriggerTerms.size === 0) return undefined;

  const phrases = phrasesOf(String(r.id));

  // Einzelterm: trägt nur, wenn er wie ein Bezeichner aussieht UND selten ist
  // (recall_when-DF, nicht die Summe über alle Felder). Geprüft an der ROHEN
  // Schreibweise jedes Phrasen-Wortes — sonst ist camelCase schon vor dem
  // Vergleich weggefaltet.
  for (const phrase of phrases) {
    for (const word of phrase.split(/\s+/)) {
      if (!word) continue;
      for (const rawToken of tokenizeWithIdentifiers(word)) {
        const folded = rawToken.toLowerCase();
        if (!matchedTriggerTerms.has(folded)) continue;
        const df = recallWhenDocFreq(folded);
        if (looksLikeIdentifier(rawToken) && df > 0 && df <= ANCHOR_RARE_DF_MAX) return "strong";
      }
    }
  }

  // Zweierregel: „zwei exakte Trigger-Terme" heißt zwei verschiedene
  // Wortursprünge, die auf zwei verschiedene Query-Terme abbilden — nicht
  // nur zwei verschiedene Ursprünge. `my-app your-app` gegen die Query
  // `app` sind zwei Wörter, aber beide treffen (über die Dual-Emission)
  // ausschließlich denselben einen Term `app` — das ist EIN Query-Term, kein
  // Beleg für zwei.
  //
  // Pro Ursprung wird deshalb die MENGE der getroffenen signifikanten Terme
  // gemerkt (Schlüssel ist wie zuvor die normalisierte Emissionssignatur —
  // Wiederholungen und Satzzeichen-Varianten desselben Wortes bleiben EIN
  // Ursprung, dessen Treffermengen zusammengeführt werden). "Strong" gilt,
  // wenn zwei Ursprünge A und B existieren, die sich auf zwei DISTINKTE
  // Terme verteilen lassen (ein bipartites Matching der Größe 2).
  //
  // Reicht "A und B treffen unterschiedliche Mengen" als Test? Nein — wenn
  // A und B beide NUR `{app}` treffen, sind ihre Mengen identisch (korrekt
  // weak), aber wenn A und B beide `{app, konfig}` treffen (identische
  // Mengen!), gibt es sehr wohl ein Matching (A→app, B→konfig) und es MUSS
  // strong sein. Der Mengen-Vergleich sagt in diesem Fall "gleich" und würde
  // fälschlich weak liefern. Die tatsächliche Bedingung (Hall'sches Kriterium
  // für zwei Mengen) ist einfacher: ein SDR der Größe 2 existiert genau dann,
  // wenn |A ∪ B| >= 2 — das versagt nur, wenn A und B beide dasselbe
  // Einzelelement sind.
  for (const phrase of phrases) {
    const originTerms = new Map<string, Set<string>>();
    for (const word of phrase.split(/\s+/)) {
      if (!word) continue;
      const emitted = tokenizeWithIdentifiers(word).map((t) => t.toLowerCase());
      if (emitted.length === 0) continue;
      const hits = emitted.filter((t) => matchedTriggerTerms.has(t) && isSignificantTriggerTerm(t));
      if (hits.length === 0) continue;
      const origin = emitted.join("\0");
      const existing = originTerms.get(origin);
      if (existing) {
        for (const t of hits) existing.add(t);
      } else {
        originTerms.set(origin, new Set(hits));
      }
    }
    const origins = Array.from(originTerms.values());
    for (let i = 0; i < origins.length; i++) {
      for (let j = i + 1; j < origins.length; j++) {
        const union = new Set([...origins[i], ...origins[j]]);
        if (union.size >= 2) return "strong";
      }
    }
  }
  return "weak";
}

/**
 * DF-Grenze, unter der ein identifierartiger Trigger-Term für sich Absicht
 * belegt. `5` — konservative Setzung ohne Labels, kein kalibrierter Wert.
 * Jetzt gegen `recallWhenDocFreq` gemessen (distinkte Memories mit dem Term
 * in `recall_when`), nicht mehr gegen die feldübergreifende Summe.
 */
const ANCHOR_RARE_DF_MAX = 5;

/**
 * Ist `term` (roh, in Original-Schreibweise) selbst signifikant genug, um zur
 * Zweierregel beizutragen? Filtert Funktionswörter (geteilte Liste mit dem
 * Reflex-Pfad, #360) und Kurzwörter unter der Signifikanz-Mindestlänge —
 * zwei x-beliebige Allerweltswörter derselben Phrase sind keine Absicht,
 * auch wenn beide exakt in der Query stehen.
 */
function isSignificantTriggerTerm(term: string): boolean {
  return term.length >= MIN_SIGNIFICANT_TOKEN_LEN && !PHRASE_STOPWORDS.has(term);
}

/**
 * Trägt dieser eine Term für sich, oder ist er nur ein Wort?
 *
 * MUSS auf der ROHEN, ungefalteten Schreibweise laufen — camelCase
 * (`NSHostingController`) ist danach durch `processTerm` bereits zu
 * `nshostingcontroller` gefaltet und nicht mehr von einem langen deutschen
 * Wort zu unterscheiden.
 *
 * #360: die reine Längenschwelle (`>= 12`) ist raus. Gemessen an 4219
 * Trigger-Termen mit df<=5 bestanden 2886 die alte Heuristik, davon 646 NUR
 * wegen der Länge — im Deutschen sind lange natürliche Wörter normal
 * („Zusammenfassung", „Benachrichtigung"), Länge allein trägt also keine
 * Bezeichner-Aussage. Ersetzt durch die Case-Form: ein innerer Wechsel von
 * klein- zu großgeschrieben (camelCase, `myApp`) oder ein Lauf aus zwei-plus
 * Großbuchstaben (Akronym-Präfix wie in `NSHostingController`) schreibt
 * niemand beiläufig — ein Wort dieser Form IST ein Name.
 */
function looksLikeIdentifier(term: string): boolean {
  if (term.length < 4) return false;
  if (/[./_-]/.test(term) || /\d/.test(term)) return true;
  return /[a-z][A-Z]/.test(term) || /[A-Z]{2,}/.test(term);
}
