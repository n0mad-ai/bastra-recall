import type { Memory } from "./schema.js";
import type { Vault, VaultEvent } from "./vault.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { fuseRRF, RRF_SCALE } from "./embeddings.js";
import type { RecallStage, StageListener } from "./recall-stages.js";
import { normalizeQuery, tokenizeWithIdentifiers } from "./query-normalize.js";
import { PHRASE_STOPWORDS, MIN_SIGNIFICANT_TOKEN_LEN } from "./stopwords.js";
import { DocFreqMiniSearch } from "./doc-freq-index.js";
import { rareTermFuzzy } from "./bm25-expansion.js";
import { groupQueryTerms, groupedTokenize } from "./bm25-grouping.js";
import { capBm25Query } from "./bm25-query-cap.js";
import { abandonAfter } from "./deadline.js";
import { scopeEquals } from "./scope.js";
import type { CueProjection } from "./cue-sidecar.js";

export interface RecallHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  topic_path: string[];
  score: number;
  matched_terms: string[];
  /** „bm25" | „vector" | „hybrid" — primärer Treffer-Modus für Telemetrie. */
  mode?: "bm25" | "vector" | "hybrid";
  /** „direct" | „1-hop" — bei Multi-Hop-Recall: ob das Memory ein direkter
   *  Match war oder ein Nachbar über `related_via`. UI kann das anders rendern. */
  hop?: "direct" | "1-hop";
  /** true wenn ein Query-Term auf dem HAND-geschriebenen `recall_when` matchte
   *  (nicht `recall_when_expanded`, nicht title/tags/topic/body). Signal für
   *  einen „deliberate" Treffer — der Autor hat genau diesen Kontext als Trigger
   *  deklariert. Genutzt vom Hook-Scope-Filter (#148), um starke, absichtliche
   *  Cross-Scope-Hits durchzulassen ohne den tag/topic-Noise (#110) zu öffnen. */
  matched_recall_when?: boolean;
  /**
   * P0: Wie tragfähig der Anker ist — `"strong"` (zwei exakte Trigger-Terme
   * oder ein seltener), `"weak"` (genau ein häufiger). Fehlt, wenn gar kein
   * Trigger-Term traf.
   *
   * Der Cross-Scope-Bypass (`hook-skip.ts`) verlangt `"strong"`: Ein einzelnes
   * Allerweltswort, das zufällig in einer fremden Triggerphrase steht, ist
   * keine Absichtserklärung.
   */
  anchor_strength?: "strong" | "weak";
  /** #230: RRF-Herkunft des Scores auf dem Hybrid-Pfad. Der `score` ist eine
   *  skalierte Rang-Summe, keine Content-Similarity — dieses Feld macht
   *  dekomponierbar, woraus die Zahl besteht. Nur auf dem Hybrid-Pfad gesetzt
   *  (das reine BM25-`recall()` lässt es weg); im lean-Response nicht enthalten,
   *  nur bei `verbosity: "full"`. */
  rrf?: {
    /** 1-basierter Rang im BM25-Arm, `null` wenn dieser Arm den Hit nicht führte. */
    rank_bm25: number | null;
    /** 1-basierter Rang im Vector-Arm, `null` wenn dieser Arm den Hit nicht führte. */
    rank_vector: number | null;
    /**
     * Unskalierter RRF-Wert (Σ 1/(k+rank)) vor der RRF_SCALE-Skalierung, die
     * `score` ergibt: `round3(raw × RRF_SCALE) === score`, auf JEDEM Pfad.
     *
     * Das schließt den Commons-Arm ein, wenn er zu diesem Hit beigetragen hat
     * (siehe `commons-fusion.ts`) — der Beitrag wurde dort früher nur auf den
     * ausgelieferten Score addiert, und `raw` erklärte danach eine Zahl, die
     * gar nicht mehr serviert wurde (gemessen: 225.574 gegen 160). Wer den
     * Anteil OHNE Commons braucht, liest `personal_score`.
     */
    raw: number;
    /**
     * Der Commons-Arm, nur gesetzt wenn er zu DIESEM Hit etwas beigetragen hat
     * (siehe `commons-fusion.ts`).
     *
     * Codex-Gegenreview (P0): Ohne diese drei Felder erklärte das
     * Evidence-Objekt den ausgelieferten Score nicht mehr. Es nannte die
     * persönlichen Ränge, während die Zahl daneben zusätzlich einen
     * Commons-Beitrag enthielt — ein Feld, das eine Zahl erklären soll und es
     * nur zur Hälfte tut, ist irreführender als keines.
     */
    /** 1-basierter Rang im Commons-Index. */
    rank_commons?: number;
    /**
     * Nur auf dem KOLLAPS-Pfad (der persönliche Arm war degradiert): der Rang
     * des Treffers in der persönlichen Liste. Dort geht nicht der persönliche
     * Zahlenwert in den Score ein, sondern nur dieser Rang — `rank_bm25` und
     * `rank_vector` beschreiben die Zahl dann nicht mehr und sind `null`.
     */
    rank_personal_list?: number;
    /** Vertrauensgewicht dieses Commons-Treffers (`commonsRankFactor`, 0.5–0.95). */
    commons_weight?: number;
    /** Der Score OHNE den Commons-Beitrag — die Zahl, die derselbe Recall
     *  ohne aktive Commons ausgeliefert hätte. */
    personal_score?: number;
  };
}

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
function matchedRecallWhen(
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
function anchorStrength(
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

export interface RecallOptions {
  k?: number;
  scope?: string; // exact-match filter
  type?: string; // exact-match filter
  /**
   * Sensitivity-Filter (#58). Default `false` — externe MCP-Caller (Claude
   * Code, Cursor, etc.) sehen keine als `private` markierten Memories. Die
   * Mac-App ruft mit `allow_private: true` und sieht alles.
   */
  allow_private?: boolean;
  /**
   * Multi-Hop-Recall (#30 / #51). Default `0` — nur direkte BM25/Vector-Hits.
   * Bei `1`: nach den direkten Treffern werden deren `related_via`-Nachbarn
   * (1-Hop) eingehängt, mit reduziertem Score. UI kennzeichnet sie als
   * `hop: "1-hop"`.
   */
  expand_hops?: 0 | 1;
  /**
   * Stage-Event-Listener (#38). Wenn gesetzt, emittiert die Recall-
   * Pipeline pro Schritt einen Start- + Stop-Event (`query.parse`,
   * `bm25.search`, `vector.search`, `rrf.fuse`, `hops.expand`,
   * `staleness.rank`, `done`). Bei Query-Cache-Hits feuert zusätzlich
   * ein `cache.hit`-Event mit `meta.cache = "query"` — danach folgt
   * direkt `done`. Null-Overhead, wenn nicht gesetzt.
   */
  onStage?: StageListener;
  /**
   * #121: receives the DEEPER candidate pool (before the top-k slice / score floor),
   * so the "far slice" — relevant memories that ranked below the returned k or below
   * the floor and would otherwise be dropped from telemetry — becomes observable for
   * offline bridge harvesting. Null-overhead when unset.
   *
   * #365/16: die Scores sind die GEDÄMPFTEN (post-staleness/curator/doc) —
   * dieselbe Skala und dieselbe Reihenfolge wie die servierten Hits.
   * #365/5: feuert auch bei einem Query-Cache-Hit, mit derselben Tiefe wie
   * auf dem kalten Pfad.
   */
  onCandidatePool?: (pool: RecallHit[]) => void;
  /**
   * #342: per-arm deadline for the vector leg, in ms. The two arms have
   * measurably different cost profiles — BM25 is in-memory, the dense arm needs
   * a warm model — but they share one deadline today, so a cold Ollama makes the
   * whole call miss it and the caller gets nothing (#305: 734ms cold vs ~161ms
   * warm, against a 600ms hook budget).
   *
   * When the vector arm exceeds this, it is ABANDONED, not aborted: the embed
   * call keeps running so the model finishes loading and the next call is warm.
   * The result degrades to BM25 through the same path an empty vector arm takes
   * (see #240/B1 below for why one-armed RRF is not an option).
   *
   * Unset or 0 = wait indefinitely, the pre-#342 behaviour.
   */
  vector_deadline_ms?: number;
  /**
   * #362: Zeichen-Budget für die Query des LEXIKALISCHEN Arms. Unset/`0` =
   * Cap AUS (Default, siehe `bm25Query()` unten für die Begründung). Nur ein
   * EXPLIZIT gesetzter Wert > 0 aktiviert ihn — z.B. `BM25_QUERY_MAX_CHARS`
   * für den in #362 gemessenen 200er-Cap.
   *
   * Betrifft nur BM25. Der Dense-Arm sieht immer die vollständige Query.
   */
  bm25_query_max_chars?: number;
  /**
   * #362: DF-Schwelle, ab der ein Query-Term seine Fuzzy-Expansion verliert.
   * Unset/`0` = Verhalten vor #362 (Fuzzy für ALLE Terme), der Default. Ein
   * gesetzter Wert — z.B. `BM25_FUZZY_RARE_DF_MAX` — expandiert nur noch
   * seltene Terme.
   *
   * Anders als `bm25_query_max_chars` entfernt das KEINEN Term: Jeder sucht
   * weiter exakt und mit Präfix, nur die Fuzzy-Nachbarschaft häufiger Terme
   * entfällt. Begründung und Messung in `bm25-expansion.ts`.
   */
  bm25_fuzzy_rare_df_max?: number;
  /**
   * #362 Phase 3: Der schnelle lexikalische Pfad — exact + prefix, KEIN Fuzzy.
   *
   * Für den Fall, den keine der anderen Stellschrauben löst: eine Maschine ohne
   * Embeddings, ein langer Prompt, und trotzdem ein Budget. Gemessen sind das
   * 140 ms p50 / 194 ms p90 gegen 1137 ms des vollen Arms — der einzige Weg,
   * dort überhaupt in die Nähe von 200 ms zu kommen.
   *
   * Der Preis ist echt und wird hier nicht kleingeredet: Ohne Fuzzy findet ein
   * vertipptes Wort sein Memory nicht mehr. Deshalb default AUS und dem
   * Aufrufer überlassen, der sein Budget kennt — nicht als globale Einstellung,
   * die einmal gesetzt und dann vergessen wird.
   */
  bm25_no_fuzzy?: boolean;
  /**
   * Die UNVERÄNDERTE Benutzerquery, wenn `query` maschinell erweitert wurde
   * (Learned Bridges, `expandQuery`). Codex-Gegenreview: Ohne dieses Feld
   * galten hinzuerfundene Bridge-Terme als exakte Query-Terme — sie konnten
   * `matched_recall_when` setzen, `weak_result` unterdrücken und einen
   * Cross-Scope-Anker erzeugen, obwohl der Benutzer den Term nie geschrieben
   * hat. Genau das sollte der Anker seit P0 ausschließen: Er misst
   * AUTORENABSICHT auf beiden Seiten — ein hand-geschriebener Trigger trifft
   * ein selbst getipptes Wort.
   *
   * Fürs RANKING bleibt die erweiterte Query maßgeblich; die Erweiterung soll
   * Treffer finden. Nur die Berechtigungs- und Ankerentscheidungen ziehen sich
   * auf das zurück, was der Mensch geschrieben hat. Fehlt das Feld, ist
   * `query` selbst die authored Query — Aufrufer ohne Expansion ändern nichts.
   */
  authored_query?: string;
}

interface IndexDoc {
  id: string;
  title: string;
  summary: string;
  tags_flat: string;
  recall_when_flat: string;
  recall_when_expanded_flat: string;
  topic_path_flat: string;
  body: string;
  /**
   * §11.4: die abgeleiteten Cues als ACHTES Feld, nie in `recall_when_flat`
   * hineingeschrieben — „handgeschriebenes `recall_when` und abgeleiteter Cue
   * haben verschiedene Vertrauensklassen und werden nie zu einem Feld
   * verschmolzen". Optional, weil es ohne geladene Projektion gar nicht erst
   * entsteht (siehe Konstruktor).
   */
  cues_flat?: string;
  // not searched, just stored
  type: string;
  scope: string;
  topic_path: string[];
  obsolete: boolean;
  confidence: number;
  sensitivity: string;
}

/**
 * Womit die Cue-Schicht (§11.4) am Index angemeldet wird.
 *
 * Beides sind FREIE Parameter im Sinne von §18.3: Sie werden auf dem
 * Auswahlteil der registrierten Aufteilung bestimmt und nicht hier gesetzt.
 * Ohne dieses Argument — dem Produktionszustand — verhält sich der Index
 * exakt wie vor der Cue-Schicht.
 */
export interface CueIndexOptions {
  /** Die geladene Projektion (`cue-sidecar.ts`). */
  projection: CueProjection;
  /** Feldgewicht des Cue-Felds. Default 0 = aus, Feld wird nicht angelegt. */
  boost?: number;
}

/**
 * In-memory BM25 search over the vault.
 * Built on minisearch — handles ~thousands of memorys easily.
 * Field weights chosen so title + recall_when + tags > body.
 */
export class SearchIndex {
  private mini: DocFreqMiniSearch<IndexDoc>;
  private detach?: () => void;
  private embeddings?: EmbeddingIndex;

  // Staleness-Cache (#29): `computeStaleness()` parsed Date-Strings und
  // rechnet Ratio-Logik — pro Recall × Hit-Count summiert sich das. Cache
  // ist memId → { touchTs, status, computedAt }. Invalidiert in `handle()`
  // bei change/remove, plus 12h-TTL gegen Tageswechsel (`aging → stale`
  // ohne Vault-Change).
  private stalenessCache = new Map<
    string,
    { touchTs: number; status: StaleStatus; computedAt: number }
  >();
  private static readonly STALENESS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

  // Curator-Demotions (#155): id-Set, vom Daemon nach jedem Curator-Pass
  // (und beim Boot aus dem State-File) gesetzt. Reiner Score-Mechanismus —
  // siehe CURATOR_DEMOTION_MULTIPLIER.
  private curatorDemotions = new Set<string>();

  /** Ersetzt das aktive Demotion-Set (score-only, #155). Leert den
   *  Query-Cache, damit die neue Gewichtung sofort greift. */
  setDemotions(ids: Iterable<string>): void {
    this.curatorDemotions = new Set(ids);
    this.queryCache.clear();
  }

  // #360: recall_when-DF für `anchorStrength` — wie viele DISTINKTE Memories
  // tragen `term` (gefaltet) in ihrem `recall_when`? `DocFreqMiniSearch.docFreq()`
  // summiert über alle sieben indizierten Felder und ist damit für die
  // Anker-Seltenheit die falsche Zahl (ein Term in zehn Bodies zählt zehnfach
  // mit, obwohl er nur einmal authored getriggert wurde). Gepflegte Zähl-Map
  // statt Live-Scan: ein Anker-Check pro Recall-Hit würde sonst den ganzen
  // Vault durchlaufen. `recallWhenTermsByMemId` hält die zuletzt gezählten
  // Terme pro Memory, damit `change`/`remove` sie sauber wieder abziehen kann.
  private recallWhenTermFreq = new Map<string, number>();
  private recallWhenTermsByMemId = new Map<string, Set<string>>();

  /** Zieht die zuletzt gezählten recall_when-Terme einer Memory wieder ab —
   *  Vorstufe für Re-Index (`change`) und `remove`. No-op, wenn die id noch
   *  nie gezählt wurde (erste Indizierung). */
  private forgetRecallWhenTerms(id: string): void {
    const terms = this.recallWhenTermsByMemId.get(id);
    if (!terms) return;
    for (const t of terms) {
      const n = this.recallWhenTermFreq.get(t) ?? 0;
      if (n <= 1) this.recallWhenTermFreq.delete(t);
      else this.recallWhenTermFreq.set(t, n - 1);
    }
    this.recallWhenTermsByMemId.delete(id);
  }

  /** Wie viele Memories tragen `term` (gefaltet) in ihrem `recall_when` —
   *  DISTINKTE Memories, nicht die feldübergreifende Summe. */
  private recallWhenDocFreq(term: string): number {
    return this.recallWhenTermFreq.get(term.toLowerCase()) ?? 0;
  }

  // Query-Cache (#30): MiniSearch tokenisiert die Query bei jedem
  // `recall()` neu. Hooks rufen häufig mit identischer Query auf
  // (detectTopics() ist deterministisch). LRU via Map-insertion-order,
  // hard cap 100 Einträge, TTL 30s. Vault-Change leert komplett.
  // #365/5: der Eintrag trägt den TIEFEN Pool mit, nicht nur die servierten k
  // Hits. `onCandidatePool` ist der einzige Weg nach draußen für die Kandidaten
  // unterhalb von k (Reflex-/Hop-Seeds, far-slice-Harvest) — ohne Pool im Cache
  // lieferte ein Hit für die volle TTL nichts (BM25) bzw. Tiefe k statt
  // max(k*4, 20) (Hybrid). Rein In-Memory, ~20 flache Objekte pro Eintrag.
  private queryCache = new Map<
    string,
    { hits: RecallHit[]; pool: RecallHit[]; at: number; degraded?: string }
  >();
  private static readonly QUERY_CACHE_MAX = 100;
  private static readonly QUERY_CACHE_TTL_MS = 30_000;

  /**
   * Die geladene Cue-Projektion, oder `null` — und `null` ist der
   * Produktionszustand: Solange kein Generator gelaufen ist, gibt es keine
   * Sidecar-Datei (§11.4 Rollback). Dann wird `cues_flat` weder als Feld
   * angemeldet noch je gesetzt, und der Index ist derselbe wie vor der
   * Cue-Schicht — nicht „gleich gemessen", sondern gleich konstruiert.
   */
  private readonly cues: CueProjection | null;

  constructor(
    private readonly vault: Vault,
    cues?: CueIndexOptions,
  ) {
    // Freier Parameter (§18.3): Boost und alle Cue-Parameter werden auf dem
    // Auswahlteil bestimmt, nicht hier geraten. Der Default 0 heißt AUS, und
    // aus heißt: das Feld existiert nicht. Ein Boost von 0 bei angemeldetem
    // Feld wäre nicht dasselbe — ein Dokument, das NUR über einen Cue matcht,
    // käme mit Score 0 trotzdem in den Kandidatenpool und veränderte ihn.
    const boost = cues?.boost ?? 0;
    this.cues = cues && boost > 0 ? cues.projection : null;
    this.mini = new DocFreqMiniSearch<IndexDoc>({
      // #162: Identifier-erhaltender Tokenizer (Dual-Emission: `my-app.config.ts`
      // + `my app config ts`). Gilt für Index- UND Query-Seite — MiniSearch fällt
      // ohne `searchOptions.tokenize` auf diese Funktion zurück; KEIN separates
      // searchOptions.tokenize setzen, sonst bricht die Symmetrie (query-normalize.ts).
      tokenize: tokenizeWithIdentifiers,
      fields: [
        "title",
        "summary",
        "tags_flat",
        "recall_when_flat",
        "recall_when_expanded_flat",
        "topic_path_flat",
        "body",
        ...(this.cues ? (["cues_flat"] as const) : []),
      ],
      storeFields: [
        "id",
        "title",
        "type",
        "scope",
        "summary",
        "topic_path",
        "obsolete",
        "confidence",
        "sensitivity",
      ],
      searchOptions: {
        boost: {
          // recall_when is authored exactly for triggering — highest weight.
          recall_when_flat: 5,
          title: 4,
          tags_flat: 3,
          // doc2query paraphrases (#117): machine-generated, so weighted below
          // the hand-written triggers and tags but above plain body — they widen
          // far recall without outranking the author's own words.
          recall_when_expanded_flat: 2,
          topic_path_flat: 2,
          summary: 2,
          body: 1,
          // Abgeleitete Cues: eigenes Gewicht, eigener Vertrauensklasse wegen.
          // Der Wert kommt vom Aufrufer und wird auf dem Auswahlteil bestimmt
          // (§18.3) — hier steht kein geratener Standardwert.
          ...(this.cues ? { cues_flat: boost } : {}),
        },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });
  }

  /** Initial population from the vault, then subscribe to changes. */
  start(): void {
    for (const m of this.vault.list()) this.indexOne(m);
    this.detach = this.vault.on((e) => this.handle(e));
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /** Optionalen Embedding-Index registrieren — recallHybrid nutzt ihn,
   *  recall (sync) bleibt BM25-only für Backwards-Compat. */
  useEmbeddings(idx: EmbeddingIndex | undefined): void {
    this.embeddings = idx;
  }

  hasEmbeddings(): boolean {
    return this.embeddings !== undefined;
  }


  /**
   * Alles, was der lexikalische Arm für EINEN Aufruf braucht — an einer Stelle,
   * damit die drei Dinge zusammenbleiben, die zusammengehören: die gruppierte
   * Query, die Optionen, die ihre Häufigkeiten wieder einrechnen, und die
   * Termmenge für den Anker.
   *
   * Getrennt gehalten wären sie eine Fehlerquelle mit Ansage: Ein gruppierter
   * Aufruf OHNE `boostTerm` verliert das Gewicht der Wiederholung, und ein
   * `boostTerm` ohne den Identitäts-Tokenizer zählt Identifier doppelt. Beides
   * fällt nicht auf — es rankt nur anders.
   */
  private bm25Plan(
    query: string,
    opts: RecallOptions,
  ): {
    lexQuery: string;
    searchOptions: Record<string, unknown>;
    queryTerms: ReadonlySet<string>;
    /** Nur die Terme aus der AUTHORED Query — die Basis jeder Anker- und
     *  Berechtigungsentscheidung (siehe `authored_query`). */
    authoredTerms: ReadonlySet<string>;
    emitted: number;
    unique: number;
  } {
    const capped = capBm25Query(query, (term) => this.mini.docFreq(term), {
      maxChars: opts.bm25_query_max_chars ?? 0,
    });
    const grouped = groupQueryTerms(capped, tokenizeWithIdentifiers);
    const fuzzy = rareTermFuzzy((term) => this.mini.docFreq(term), opts.bm25_fuzzy_rare_df_max);
    // #362 Phase 3: `bm25_no_fuzzy` schlägt die feinere Steuerung — wer den
    // schnellen Pfad anfordert, will keine Expansion, auch keine selektive.
    const fuzzyOption = opts.bm25_no_fuzzy ? { fuzzy: false } : fuzzy ? { fuzzy } : {};
    return {
      lexQuery: grouped.query,
      searchOptions: {
        // Die Query ist bereits die Termliste — erneut zerlegen würde die
        // Dual-Emission des Identifier-Tokenizers ein zweites Mal anwenden.
        tokenize: groupedTokenize,
        boostTerm: (term: string) => grouped.counts.get(term) ?? 1,
        ...fuzzyOption,
      },
      queryTerms: new Set(grouped.counts.keys()),
      authoredTerms:
        opts.authored_query === undefined || opts.authored_query === query
          ? new Set(grouped.counts.keys())
          : new Set(groupQueryTerms(opts.authored_query, tokenizeWithIdentifiers).counts.keys()),
      emitted: grouped.emitted,
      unique: grouped.counts.size,
    };
  }

  recall(query: string, opts: RecallOptions = {}): RecallHit[] {
    // #162: Query-Hygiene für ALLE Caller (MCP-Recall, Hooks, Bridge, Dedup) —
    // Längen-Cap, Whitespace-Kollaps, dangling Operatoren. Vor dem Cache-Key,
    // damit äquivalente Queries denselben Eintrag teilen.
    query = normalizeQuery(query);
    const k = opts.k ?? 5;
    const stage = new StageEmitter(opts.onStage);
    const recallStart = Date.now();

    const tParse = stage.start("query.parse");
    if (!query.trim()) {
      stage.end("query.parse", tParse);
      stage.emit("done", recallStart, { hit_count: 0, vault_size: this.mini.documentCount, total_ms: 0 });
      return [];
    }
    stage.end("query.parse", tParse);

    // Query-Cache (#30) — bei Hit komplett überspringen, inkl. Hop-
    // Expansion und Staleness-Reranking. Cache speichert das finale
    // RecallHit[], nicht den BM25-Roh-Output.
    const cacheKey = `recall|${query}|${JSON.stringify(opts)}`;
    const cached = this.lookupQueryCache(cacheKey);
    if (cached) {
      stage.emit("cache.hit", recallStart, { cache: "query", hit_count: cached.hits.length });
      // #365/5: der Hit kehrte hier zurück, BEVOR irgendein `onCandidatePool`
      // lief — auf dem BM25-Pfad feuerte er also gar nicht. Ein einziger
      // primender Caller reichte, um Reflex- und Hop-Seeds für die volle TTL
      // verschwinden zu lassen. Replay vor `done`, damit die Reihenfolge
      // dieselbe ist wie auf dem kalten Pfad.
      this.emitCachedPool(opts, cached.pool);
      stage.emit("done", recallStart, {
        hit_count: cached.hits.length,
        vault_size: this.mini.documentCount,
        total_ms: Date.now() - recallStart,
        cached: true,
      });
      return cached.hits;
    }

    const tBm = stage.start("bm25.search");
    const plan = this.bm25Plan(query, opts);
    const lexQuery = plan.lexQuery;
    const raw = this.mini.search(lexQuery, plan.searchOptions);
    const authoredTerms = plan.authoredTerms;
    stage.end("bm25.search", tBm, {
      raw_hit_count: raw.length,
      query_chars: query.length,
      bm25_query_chars: lexQuery.length,
      // #362 Phase 0: Die Kosten des Arms hängen an der Termzahl, nicht an den
      // Zeichen — und der Abstand zwischen beiden Zahlen IST der Gewinn der
      // Gruppierung. Ohne sie in der Telemetrie ist später nicht mehr
      // nachvollziehbar, ob ein langsamer Aufruf viele Terme hatte oder viele
      // Wiederholungen.
      terms_emitted: plan.emitted,
      terms_unique: plan.unique,
    });

    const filtered = raw.filter((r) => {
      if (!passesRecallFilters(r, opts)) return false;
      return true;
    });

    const { ranked, pool } = this.rankBm25(filtered, k, opts, stage, authoredTerms);

    this.storeQueryCache(cacheKey, ranked, pool);

    stage.emit("done", recallStart, {
      hit_count: ranked.length,
      vault_size: this.mini.documentCount,
      total_ms: Date.now() - recallStart,
    });
    return ranked;
  }

  /**
   * BM25 hit construction → candidate pool → damping/re-sort → top-k → hops.
   *
   * Factored out so `recallHybrid` can degrade to the BM25 result WITHOUT
   * re-entering the public `recall()` (#240/B2 follow-up): that recursion
   * opened a second StageEmitter on the same callback, so `bm25.search` was
   * emitted twice, MCP progress jumped backwards from stage 4 to 1, telemetry
   * buckets overwrote each other, and a warm inner cache reported the whole
   * hybrid attempt as `cache.hit` while `onCandidatePool` fired zero times.
   * The caller owns `query.parse`, `bm25.search`, `done` and the cache.
   */
  private rankBm25(
    filtered: ReturnType<DocFreqMiniSearch<IndexDoc>["search"]>,
    k: number,
    opts: RecallOptions,
    stage: StageEmitter,
    /** Gefaltete Query-Terme für den exakten Anker — siehe `matchedRecallWhen`. */
    queryTerms: ReadonlySet<string>,
  ): { ranked: RecallHit[]; pool: RecallHit[] } {
    // Pool-Size für Hop-Seeds: max(k*4, 20). Multi-Hop soll Nachbarn auch
    // für Hits sehen, die knapp unter dem k-Cut liegen — sonst gehen die
    // related_via-Kanten der Positionen 6–20 verloren.
    const HOP_SEED_POOL = Math.max(k * 4, 20);
    const directFull: RecallHit[] = filtered.slice(0, HOP_SEED_POOL).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      type: r.type as string,
      scope: r.scope as string,
      summary: r.summary as string,
      topic_path: r.topic_path as string[],
      score: round(r.score),
      matched_terms: r.terms ?? [],
      matched_recall_when: matchedRecallWhen(r, queryTerms),
      ...(() => {
        const a = anchorStrength(r, queryTerms, (t) => this.recallWhenDocFreq(t), (id) =>
          this.vault.get(id)?.fm.recall_when ?? [],
        );
        return a ? { anchor_strength: a } : {};
      })(),
      mode: "bm25" as const,
      hop: "direct" as const,
    }));

    // #240/A7: apply the lifecycle/curator/doc/salience multipliers to the
    // FULL candidate pool and re-sort BEFORE cutting to k. Cutting first meant
    // a fresh hit at position k+1 could never displace an expired, demoted or
    // doc-damped hit inside the top-k — so the served top-k was not the top-k
    // of the ranking function the code actually defines. Fires whenever two
    // candidates sit within the damping factor of each other (<5× expired,
    // <2× doc/curator), which is the normal case for near-duplicate notes.
    // applyStaleness mutates scores in place, so the damping runs on a CLONE:
    // `directFull` keeps its raw scores for the hop seeds below. Damping the
    // seeds first compounded the multiplier — a neighbour behind an expired
    // seed was multiplied twice (0.2 × 0.2), dropping a fresh neighbour to 4%
    // of its raw score and below downstream floors.
    const tStale = stage.start("staleness.rank");
    const rankedFull = this.applyStaleness(directFull.map((h) => ({ ...h })), opts);
    const direct = rankedFull.slice(0, k);
    stage.end("staleness.rank", tStale, { reranked_count: direct.length });

    // #121: expose the deeper pool (incl. below-floor candidates) before slicing to k.
    // #365/16: DAMPED pool, hinter dem Damping. Vorher ging `directFull` mit
    // rohen Scores raus, während die servierten Hits gedämpft waren — zwei
    // Skalen in derselben Telemetrie, und da das Damping umsortiert, kippte
    // auch die Reihenfolge gegen die servierte. Die Hop-Seeds hängen NICHT am
    // Callback (sie greifen unten direkt auf `directFull` zu), der Pool darf
    // hier also gedämpft sein; `rankedFull` ist derselbe tiefe Pool.
    opts.onCandidatePool?.(rankedFull);

    let ranked: RecallHit[];
    if (opts.expand_hops === 1) {
      const tHops = stage.start("hops.expand");
      // Seeded from the RAW pool; each neighbour is damped exactly once, by
      // its own multiplier.
      const neighbors = this.applyStaleness(
        this.collectOneHopNeighbors(directFull, opts, new Set(direct.map((h) => h.id))),
        opts,
      ).slice(0, k);
      stage.end("hops.expand", tHops, { hop_count: neighbors.length });
      ranked = [...direct, ...neighbors];
    } else {
      ranked = direct;
    }
    // #365/5: der Pool geht mit zurück, damit der Caller ihn in den
    // Query-Cache legen und bei einem Hit erneut ausliefern kann.
    return { ranked, pool: rankedFull };
  }

  /** Hybrid-Recall: BM25 + Vector via Reciprocal-Rank-Fusion. Wenn kein
   *  EmbeddingIndex registriert ist — oder der Vektor-Arm nichts liefert
   *  (#240/B1) — fällt auf reines BM25 (sync) zurück.
   *
   *  Der finale Score ist `RRF * RRF_SCALE` (siehe :39 und die Skalierung unten),
   *  NICHT die hier früher behaupteten `* 1000`. Wichtig für jeden, der
   *  Schwellen darauf setzt: der Wert ist eine skalierte Rang-Summe, keine
   *  Ähnlichkeit — Rang 1 in beiden Armen ergibt die Obergrenze 163.934
   *  (#230). */
  async recallHybrid(query: string, opts: RecallOptions = {}): Promise<RecallHit[]> {
    if (!this.embeddings) return this.recall(query, opts);
    // #162: gleiche Query-Hygiene wie in recall() — auch der Vector-Arm
    // profitiert vom Längen-Cap (idempotent, deshalb kein Doppel-Schaden
    // beim BM25-Fallback oben).
    query = normalizeQuery(query);
    const k = opts.k ?? 5;
    const stage = new StageEmitter(opts.onStage);
    const recallStart = Date.now();

    const tParse = stage.start("query.parse");
    if (!query.trim()) {
      stage.end("query.parse", tParse);
      stage.emit("done", recallStart, { hit_count: 0, vault_size: this.mini.documentCount, total_ms: 0 });
      return [];
    }
    stage.end("query.parse", tParse);

    // Query-Cache (#30) — eigener Key-Prefix damit BM25-only und Hybrid
    // sich nicht gegenseitig überschreiben (gleicher Query-String,
    // anderes Ranking-Ergebnis).
    // #240/B2: the cache key must carry the vector generation. Otherwise a
    // result computed while the vector arm was unavailable (provider down, or
    // simply the boot-window backfill still running) survives recovery for
    // the full TTL — and the boot window is exactly when session-start hooks
    // inject. Callbacks vanish from JSON.stringify, so they never varied the
    // key; the generation does.
    const cacheKey = `hybrid|${this.embeddings.size()}|${query}|${JSON.stringify(opts)}`;
    const cached = this.lookupQueryCache(cacheKey);
    if (cached) {
      // #240/B2: the sync path emits cache.hit + done on a hit; this one
      // returned before any emission, so SSE progress and the candidate-pool
      // harvest silently saw nothing.
      stage.emit("cache.hit", recallStart, { cache: "query", hit_count: cached.hits.length });
      // #365/5: bisher gingen hier die SERVIERTEN k Hits als „Pool" raus —
      // bei k=2 also Tiefe 2 statt der 8, die derselbe Call kalt geliefert
      // hätte. Jetzt der mitgecachte tiefe Pool.
      this.emitCachedPool(opts, cached.pool);
      stage.emit("done", recallStart, {
        hit_count: cached.hits.length,
        vault_size: this.mini.documentCount,
        total_ms: Date.now() - recallStart,
        cached: true,
        // P0: der Degradations-Grund wird mit-repliziert. Er ist die einzige
        // Quelle, aus der der Recall-Handler `score_kind` ableitet — fehlt er
        // beim Cache-Hit, wird derselbe rohe BM25-Score (gemessen: 1997.338)
        // beim zweiten Aufruf als `rrf` ausgeliefert und von den Bändern
        // 50/100 gelesen, die nur auf der RRF-Skala existieren.
        ...(cached.degraded ? { degraded: cached.degraded } : {}),
      });
      return cached.hits;
    }

    // #370: der Dense-Arm wird ZUERST abgefeuert und erst nach dem BM25-Pass
    // awaited. Er ist ein Netzwerk-Roundtrip zu Ollama, BM25 ist CPU-Arbeit
    // in-process, und zwischen den Armen besteht keine Datenabhängigkeit —
    // `fuseRRF` konsumiert beide Rank-Listen ohnehin erst danach. Vorher lief
    // `this.mini.search()` vollständig durch, bevor der Embed überhaupt
    // dispatched wurde: die Wanduhr zahlte die SUMME statt des MAXIMUMS
    // (gemessen über n=1545 `hook_recall`, 19.–24.08.: `latency_ms_recall −
    // (bm25 + vector)` p50 1 ms / p90 2 ms — die Stages addierten sich exakt
    // zum Total, es überlappte nichts).
    //
    // Reines Reordering: identische Eingaben in beide Arme, identisches
    // RRF-Ergebnis. Die eine Invariante, die dabei nicht kippen darf: die
    // Deadline muss ab dem ABFEUERN laufen, nicht ab dem `await`.
    // `abandonAfter` startet seinen Timer synchron beim Aufruf — deshalb steht
    // der Aufruf hier oben und nicht unten am `await`. Unten aufgerufen bekäme
    // der Arm sein Budget PLUS die BM25-Zeit, und seine Timeout-Rate wäre
    // nicht mehr messbar.
    // #240/A8: ask for a deeper pool when a filter is active. The vault/scope/
    // type/private filter below runs AFTER the provider's global top-k, so a
    // fixed 100 silently truncated eligible candidates for every scoped query
    // — measured on a real 514-memory vault: 95.3% of scoped queries lost
    // in-scope candidates, and the smallest scopes lost a third of theirs.
    const filtered = opts.scope != null || opts.type != null || !opts.allow_private;
    // #342: race the dense arm against its own deadline. `abandonAfter` never
    // rejects and never cancels — on expiry it hands back null and leaves the
    // embed in flight, which is the point: the model finishes loading on the
    // call that gave up on it, so the NEXT call is warm. Cancelling here would
    // re-pay the cold load every single time.
    // #365/4: `EmbeddingIndex.search()` fängt JEDEN Provider-Fehler ab und
    // returnt `[]` — byte-identisch zu „dieser Vault hat keine Vektoren".
    // Diskriminiert wird über `runtimeHealth().errorCount`, der ausschließlich
    // in `markProviderError()` hochzählt. NICHT über `lastErrorAt`: der hat
    // ms-Auflösung, und zwei Fehler in derselben Millisekunde (zwei Lanes an
    // demselben toten Ollama) sind darüber nicht trennbar — der zweite Leser
    // sähe seinen eigenen Fehler als „stand schon vorher da" und würde die
    // einarmige Antwort cachen. Zwei Property-Reads um den ohnehin
    // vorhandenen await — kein zusätzlicher Call, kein I/O.
    const errBefore = this.embeddings.runtimeHealth().errorCount;
    const tVec = stage.start("vector.search");
    const vectorArm = abandonAfter(
      this.embeddings.search(query, filtered ? 1000 : 100),
      opts.vector_deadline_ms ?? 0,
    );

    // #305: EIN Durchlauf des Event Loops, bevor der lexikalische Arm ihn
    // synchron belegt.
    //
    // WARUM DAS NÖTIG IST. Die Zeile darüber startet den dichten Arm, aber sie
    // SENDET ihn nicht: Ein HTTP-Request verlässt den Prozess erst, wenn der
    // Loop das nächste Mal frei ist. `this.mini.search()` unten ist synchron
    // und hält ihn — bei langen Queries mehrere hundert Millisekunden. Ohne
    // diese Zeile lief also folgendes ab: Deadline-Timer startet, Ollama wird
    // gar nicht gefragt, der Timer fällt, und der Arm gilt als „zu langsam".
    //
    // Nachgestellt mit der dichten Seite in einem eigenen Prozess: ohne den
    // Durchlauf 5 von 5 Läufen im Timeout, mit ihm 0 von 5 — bei sonst
    // identischen Zeiten. In der Produktionstelemetrie ist derselbe Effekt als
    // 96 % Event-Loop-Blockade an der scheinbaren Vektorzeit sichtbar.
    //
    // WAS DAS NICHT TUT. Es ändert weder die Reihenfolge der Arme noch ihre
    // Eingaben noch die Fusion — beide bekommen dieselbe Query wie vorher, RRF
    // rechnet unverändert. Und es verschiebt die Deadline nicht: `abandonAfter`
    // hat seinen Timer oben schon gestartet, die Frist läuft weiterhin ab dem
    // Abfeuern. Ein Arm, der wirklich zu langsam ist, läuft weiterhin in seinen
    // Timeout.
    //
    // WARUM EIN TIMER UND KEIN `setImmediate`. Gemessen gegen einen echten
    // Fremdprozess, je 5 Läufe mit 300 ms Blockade:
    //
    //   nichts (vorher)   5/5 Timeouts    0,000 ms
    //   1x setImmediate   5/5 Timeouts    0,020 ms
    //   3x setImmediate   5/5 Timeouts    0,048 ms
    //   setTimeout(0)     0/5 Timeouts    1,141 ms
    //
    // `setImmediate` läuft in der Check-Phase und lässt die Poll-Phase aus —
    // genau die, in der der Socket-Connect fertig wird und der Request
    // geschrieben wird. Ein Timer durchläuft den Zyklus vollständig. Beliebig
    // viele Immediates helfen deshalb nicht; einer allein tut es hier nicht.
    //
    // Der Preis ist die Timer-Mindestauflösung, gemessen 1,1 ms, und er fällt
    // nur an, wo es überhaupt einen dichten Arm gibt: Dieser Zweig läuft nur
    // mit angehängtem Embedding-Index.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // BM25 — top 50 für RRF-Pool. Läuft jetzt IM Schatten des Dense-Arms.
    // #362: der lexikalische Arm bekommt die gekappte Query (siehe
    // `bm25Query`), der Dense-Arm oben bewusst die vollständige — Embedding-
    // Kosten sind längenunabhängig konstant (104–153 ms über alle Bänder),
    // und der semantische Arm lebt vom ganzen Kontext.
    const tBm = stage.start("bm25.search");
    const plan = this.bm25Plan(query, opts);
    const lexQuery = plan.lexQuery;
    const bm25 = this.mini
      .search(lexQuery, plan.searchOptions)
      .filter((r) => passesRecallFilters(r, opts));
    const authoredTerms = plan.authoredTerms;
    const bm25Top = bm25.slice(0, 50);
    stage.end("bm25.search", tBm, {
      raw_hit_count: bm25.length,
      query_chars: query.length,
      bm25_query_chars: lexQuery.length,
      terms_emitted: plan.emitted,
      terms_unique: plan.unique,
    });

    const vecOrTimeout = await vectorArm;
    const vectorArmTimedOut = vecOrTimeout === null;
    const errAfter = this.embeddings.runtimeHealth().errorCount;
    // Ein gewachsener Zähler heißt: über diesem await ist mindestens ein
    // Provider-Call gescheitert. Beim Timeout ist der Arm noch in-flight, der
    // Fehler gehört dann nicht zu diesem Ergebnis — `vectorArmTimedOut` hat
    // deshalb Vorrang.
    const vectorArmErrored = !vectorArmTimedOut && errAfter > errBefore;
    const vec = vecOrTimeout ?? [];
    const vectorTop = vec
      .map((h) => ({ hit: h, mem: this.vault.get(h.id) }))
      .filter(({ mem }) => {
        if (!mem) return false;
        if (mem.fm.obsolete === true) return false;
        if (opts.scope && !scopeEquals(mem.fm.scope, opts.scope)) return false;
        if (opts.type && mem.fm.type !== opts.type) return false;
        if (
          !opts.allow_private &&
          (mem.fm as { sensitivity?: string }).sensitivity === "private"
        ) {
          return false;
        }
        return true;
      })
      .slice(0, 50);
    // #370: die Spanne deckt dispatch→settle und ÜBERLAPPT `bm25.search`.
    // `overlapped` sagt jedem Leser dieser Telemetrie, dass die Stages keine
    // Partition des Totals mehr sind — genau die Residuum-Rechnung, mit der
    // die Sequentialität nachgewiesen wurde, gilt danach nicht mehr.
    stage.end("vector.search", tVec, {
      vector_hit_count: vectorTop.length,
      overlapped: true,
    });

    // #240/B1: an empty vector arm is NOT "degraded to BM25" — running RRF
    // on one arm produced a different score space, not the BM25 one. A
    // one-armed rank-1 hit scores RRF_SCALE/(RRF_K+1) = 81.967 by
    // construction, and the documented MUST_LOAD band (100) is structurally
    // unreachable on one arm at ANY k — exactly when the provider is down.
    // (The width of the band below that ceiling does move with RRF_K: at
    // k=60 rank 20 sat at 62.5, at k=5 it sits at 19.7.) Fall back to the
    // real BM25 path so scores mean what the thresholds assume.
    if (vectorTop.length === 0) {
      // Reuse the BM25 results this call already computed — no recursion into
      // the public pipeline, so the stage sequence stays monotonic and emits
      // exactly one `done` and one candidate-pool callback.
      const { ranked: bm25Only, pool: bm25Pool } = this.rankBm25(bm25, k, opts, stage, authoredTerms);
      // #342: a timeout degradation must NOT be cached. The cache key varies on
      // `embeddings.size()`, which a cold model does not change — so caching
      // here would freeze the one-armed answer for the full TTL and every
      // follow-up query in that window would be served BM25-only by a warm
      // machine. Same trap #240/B2 closed for the boot window, arriving through
      // a different door. An empty vector arm still caches: that is a property
      // of the vault, not of this call's timing.
      // #365/4: ein Provider-FEHLER ist ebenfalls eine Eigenschaft dieses
      // Calls, nicht des Vaults. `embeddings.size()` im Key bewegt sich dabei
      // nicht, also fror ein 5xx die einarmige Antwort für die volle TTL ein —
      // die Erholung des Providers kam nicht durch. Gleiche Falle wie #342,
      // durch die Nachbartür.
      if (!vectorArmTimedOut && !vectorArmErrored) {
        // P0: der Grund geht MIT in den Cache. Diese Hits sind rohe
        // BM25-Scores; ein Cache-Hit, der das verschweigt, macht sie beim
        // Leser wieder zu RRF-Werten.
        this.storeQueryCache(cacheKey, bm25Only, bm25Pool, "vector-arm-empty");
      }
      stage.emit("done", recallStart, {
        hit_count: bm25Only.length,
        vault_size: this.mini.documentCount,
        total_ms: Date.now() - recallStart,
        degraded: vectorArmTimedOut
          ? "vector-arm-timeout"
          : vectorArmErrored
            ? "vector-arm-error"
            : "vector-arm-empty",
      });
      return bm25Only;
    }

    const tFuse = stage.start("rrf.fuse");
    const bm25Ids = bm25Top.map((r) => r.id as string);
    const vectorIds = vectorTop.map(({ hit }) => hit.id);
    const fused = fuseRRF(bm25Ids, vectorIds);

    // Lookup-Maps für die finale Hit-Konstruktion.
    const bm25Lookup = new Map(bm25Top.map((r) => [r.id as string, r]));
    const vectorLookup = new Map(vectorTop.map((v) => [v.hit.id, v]));

    const sorted = Array.from(fused.entries()).sort((a, b) => b[1].score - a[1].score);
    // Größerer Pool für Hop-Seeds (siehe recall()-Kommentar).
    const HOP_SEED_POOL = Math.max(k * 4, 20);
    const outFull: RecallHit[] = [];
    for (const [id, entry] of sorted) {
      if (outFull.length >= HOP_SEED_POOL) break;
      const bm = bm25Lookup.get(id);
      const v = vectorLookup.get(id);
      const mem = v?.mem ?? this.vault.get(id);
      if (!mem) continue;
      const fm = mem.fm;
      const inBoth = bm !== undefined && v !== undefined;
      outFull.push({
        id: fm.id,
        title: fm.title,
        type: fm.type,
        scope: fm.scope,
        summary: fm.summary,
        topic_path: fm.topic_path,
        // RRF-Score skaliert auf BM25-vergleichbare Range. Der Faktor hängt an
        // RRF_K (embeddings.ts), damit die Anker 163.934 / 81.967 stehen
        // bleiben, wenn sich die Fusion ändert.
        score: round(entry.score * RRF_SCALE),
        matched_terms: bm?.terms ?? [],
        // #148: vom BM25-Arm; ein reiner Vektor-Treffer (kein `bm`) ist kein
        // lexikalisches recall_when-Match → false.
        matched_recall_when: bm ? matchedRecallWhen(bm, authoredTerms) : false,
        ...(() => {
          const a = bm
            ? anchorStrength(bm, authoredTerms, (t) => this.recallWhenDocFreq(t), (id) =>
                this.vault.get(id)?.fm.recall_when ?? [],
              )
            : undefined;
          return a ? { anchor_strength: a } : {};
        })(),
        mode: inBoth ? "hybrid" : bm ? "bm25" : "vector",
        hop: "direct" as const,
        // #230: Rang-Herkunft des skalierten Scores durchreichen (nur Hybrid).
        rrf: { rank_bm25: entry.rank_bm25, rank_vector: entry.rank_vector, raw: entry.score },
      });
    }
    stage.end("rrf.fuse", tFuse, { fused_count: outFull.length });

    // #240/A7: same ordering fix as the BM25 path — multipliers and re-sort
    // over the full pool, THEN cut to k. Damping runs on a clone so `outFull`
    // keeps raw scores for the hop seeds (see the BM25 path for why).
    const tStale = stage.start("staleness.rank");
    const rankedFull = this.applyStaleness(outFull.map((h) => ({ ...h })), opts);
    const out = rankedFull.slice(0, k);
    stage.end("staleness.rank", tStale, { reranked_count: out.length });

    // #121: expose the deeper pool (incl. below-floor candidates) before slicing to k.
    // #365/16: gedämpfter Pool, hinter dem Damping — gleiche Skala und gleiche
    // Reihenfolge wie die servierten Hits (siehe rankBm25).
    opts.onCandidatePool?.(rankedFull);

    let ranked: RecallHit[];
    if (opts.expand_hops === 1) {
      const tHops = stage.start("hops.expand");
      const neighbors = this.applyStaleness(
        this.collectOneHopNeighbors(outFull, opts, new Set(out.map((h) => h.id))),
        opts,
      ).slice(0, k);
      stage.end("hops.expand", tHops, { hop_count: neighbors.length });
      ranked = [...out, ...neighbors];
    } else {
      ranked = out;
    }

    this.storeQueryCache(cacheKey, ranked, rankedFull);

    stage.emit("done", recallStart, {
      hit_count: ranked.length,
      vault_size: this.mini.documentCount,
      total_ms: Date.now() - recallStart,
    });
    return ranked;
  }

  /**
   * Multi-Hop-Expansion (#30 / #51): sammelt `related_via.id`-Nachbarn aus
   * den Seed-Hits (typischerweise top-20 aus dem BM25/Hybrid-Pool, nicht nur
   * top-k — sonst gehen Nachbarn von Position 6–20 verloren), filtert sie
   * (obsolete / scope / type / sensitivity / dedup gegen `exclude`), und
   * liefert sie mit reduziertem Score sortiert zurück. Score-Reduktion:
   * `seed.score * 0.5 * link.score` (heuristisch — Nachbarn sollen nie über
   * direkte Treffer ranken). Wenn ein Nachbar mehrfach gefunden wird, gewinnt
   * der höchste Score.
   */
  private collectOneHopNeighbors(
    seeds: RecallHit[],
    opts: RecallOptions,
    exclude: Set<string>,
  ): RecallHit[] {
    if (seeds.length === 0) return [];
    const best = new Map<string, RecallHit>();
    for (const seed of seeds) {
      const mem = this.vault.get(seed.id);
      const related = (mem?.fm as { related_via?: { id: string; reason: string; score: number }[] })
        ?.related_via;
      if (!related?.length) continue;
      for (const link of related) {
        if (exclude.has(link.id)) continue;
        const neigh = this.vault.get(link.id);
        if (!neigh) continue;
        if (neigh.fm.obsolete === true) continue;
        if (opts.scope && !scopeEquals(neigh.fm.scope, opts.scope)) continue;
        if (opts.type && neigh.fm.type !== opts.type) continue;
        if (
          !opts.allow_private &&
          (neigh.fm as { sensitivity?: string }).sensitivity === "private"
        ) {
          continue;
        }
        const score = round(seed.score * 0.5 * link.score);
        const prior = best.get(link.id);
        if (prior && prior.score >= score) continue;
        best.set(link.id, {
          id: neigh.fm.id,
          title: neigh.fm.title,
          type: neigh.fm.type,
          scope: neigh.fm.scope,
          summary: neigh.fm.summary,
          topic_path: neigh.fm.topic_path,
          score,
          matched_terms: [],
          mode: seed.mode,
          hop: "1-hop" as const,
        });
      }
    }
    return Array.from(best.values()).sort((a, b) => b.score - a.score);
  }

  loadFull(id: string): Memory | undefined {
    return this.vault.get(id);
  }

  size(): number {
    return this.mini.documentCount;
  }

  // ─── internals ───────────────────────────────────────────────

  private handle(e: VaultEvent): void {
    if (e.kind === "remove") {
      // Staleness-Cache invalidieren (#29) — memId genügt.
      this.stalenessCache.delete(e.id);
      // #360: recall_when-DF-Map — die Terme dieser Memory zählen nicht mehr
      // mit. `indexOne()` (add/change) macht das intern selbst; hier muss es
      // explizit passieren, weil kein neuer Indexier-Aufruf folgt.
      this.forgetRecallWhenTerms(e.id);
      // Query-Cache komplett leeren (#30) — selektive Invalidierung wäre
      // ein eigenes Ranking-Problem und Vault-Changes sind selten.
      this.queryCache.clear();
      try {
        this.mini.discard(e.id);
      } catch {
        // not indexed; ignore
      }
      return;
    }
    if (e.kind === "change") {
      this.stalenessCache.delete(e.memory.fm.id);
      this.queryCache.clear();
      try {
        this.mini.discard(e.memory.fm.id);
      } catch {
        // first time; treat as add
      }
    } else if (e.kind === "add") {
      // Neue Memory könnte BM25-Ranking aller bestehenden Queries
      // verändern → Query-Cache leeren. Staleness wird ohnehin lazy
      // beim nächsten Recall berechnet.
      this.queryCache.clear();
    }
    this.indexOne(e.memory);
  }

  /**
   * Staleness-Reranking mit Per-Memory-Cache (#29). Cache-Key ist die
   * memId — invalidiert in `handle()` bei change/remove. Zusätzlich
   * 12h-TTL gegen Tageswechsel-Flips (`aging → stale` ohne Vault-Change).
   *
   * Behält die Sortier-Semantik von `applyStalenessMultiplier`: Direct-
   * vs 1-hop-Hits bleiben getrennt sortiert.
   *
   * Doc-Dämpfung: type="doc" (Document-Sidecars + Produkt-Doku) wird im
   * Default-Recall (kein expliziter type-Filter) gedämpft — lange Doc-Bodies
   * sollen Lessons/Decisions nicht verdrängen. `find_document` und jeder
   * Recall mit type:"doc" ranken ungedämpft (das ist die dedizierte Lane).
   */
  private applyStaleness(hits: RecallHit[], opts: RecallOptions = {}, now: Date = new Date()): RecallHit[] {
    const nowMs = now.getTime();
    for (const h of hits) {
      const fm = this.vault.get(h.id)?.fm as Record<string, unknown> | undefined;
      if (!fm) continue;
      const touchTs = computeTouchTs(fm);
      let entry = this.stalenessCache.get(h.id);
      const ttlExpired =
        entry != null && nowMs - entry.computedAt > SearchIndex.STALENESS_CACHE_TTL_MS;
      if (!entry || entry.touchTs !== touchTs || ttlExpired) {
        const status = computeStaleness(fm, now);
        entry = { touchTs, status, computedAt: nowMs };
        this.stalenessCache.set(h.id, entry);
      }
      let mult = STALE_MULTIPLIERS[entry.status];
      if (this.curatorDemotions.has(h.id)) mult *= CURATOR_DEMOTION_MULTIPLIER;
      if (!opts.type && h.type === "doc") mult *= DOC_TYPE_DAMPING;
      // #217: Salience boostet nur im Live-Modus (default: shadow-only im
      // Daemon). Prozess-statisch schalten — nie pro Request. Case-insensitiv
      // wie salienceRankMode() im Daemon — sonst schaltet "LIVE" beide Lanes
      // still aus (Review-Finding).
      if ((process.env.BASTRA_SALIENCE_RANK ?? "").toLowerCase() === "live") {
        const sal =
          typeof fm.salience === "number" ? Math.min(Math.max(fm.salience, 0), 1) : 0;
        if (sal > 0) mult *= 1 + sal * salienceRankCap();
      }
      if (mult !== 1.0) h.score = round(h.score * mult);
    }
    const direct = hits.filter((h) => h.hop !== "1-hop");
    const hops = hits.filter((h) => h.hop === "1-hop");
    direct.sort((a, b) => b.score - a.score);
    hops.sort((a, b) => b.score - a.score);
    return [...direct, ...hops];
  }

  /**
   * LRU-Lookup für `queryCache` (#30). Bei Hit wird der Eintrag
   * re-inserted, damit die Map-insertion-order ihn als „recently used"
   * sieht. TTL 30s — frische Edits sollen den Cache nicht zu lange
   * dominieren, auch wenn der Watcher nicht feuert.
   */
  private lookupQueryCache(
    key: string,
  ): { hits: RecallHit[]; pool: RecallHit[]; degraded?: string } | undefined {
    const cached = this.queryCache.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.at > SearchIndex.QUERY_CACHE_TTL_MS) {
      this.queryCache.delete(key);
      return undefined;
    }
    // LRU-Bump: löschen + neu setzen, damit Map-iteration den Eintrag
    // als jüngsten sieht.
    this.queryCache.delete(key);
    this.queryCache.set(key, cached);
    // Defensive Kopie — Caller könnte das Array mutieren (sortieren,
    // pushen). Cache-Werte bleiben damit stabil über Calls hinweg.
    // #365/5: `pool` ist bewusst die CACHE-INTERNE Referenz und darf so nie
    // nach außen — der defensive Klon liegt in `emitCachedPool()`, damit ein
    // Cache-Hit ohne `onCandidatePool` keine einzige Allokation mehr kostet
    // als vor #365 (Hook-Budget #305/#362).
    // P0: `degraded` muss mit raus. Der Score-RAUM (rohes BM25 vs. RRF) ist
    // eine Eigenschaft des gecachten Ergebnisses, nicht des Calls, der es
    // ausliefert — ohne dieses Feld nannte der Handler dieselben Zahlen beim
    // zweiten Aufruf `rrf` und legte die Bänder 50/100 an eine offene Skala.
    return { hits: cached.hits.map((h) => ({ ...h })), pool: cached.pool, degraded: cached.degraded };
  }

  /** #365/5: den mitgecachten tiefen Pool bei einem Query-Cache-Hit
   *  nachliefern. Defensiver Klon nur hier, und nur wenn jemand zuhört. */
  private emitCachedPool(opts: RecallOptions, pool: RecallHit[]): void {
    if (!opts.onCandidatePool) return;
    opts.onCandidatePool(pool.map((h) => ({ ...h })));
  }

  private storeQueryCache(
    key: string,
    hits: RecallHit[],
    pool: RecallHit[],
    degraded?: string,
  ): void {
    if (this.queryCache.size >= SearchIndex.QUERY_CACHE_MAX) {
      // Oldest first — Map preserved insertion order.
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    // Kopie der Hit-Objekte, gleicher Grund wie in lookupQueryCache. Bewusst
    // FLACH: `topic_path`, `matched_terms` und `rrf` bleiben mit dem Original
    // geteilt. Das reicht, weil die Pipeline nur `score` schreibt (in
    // applyStaleness) und Consumer die Arrays lesen; ein tiefer Klon wäre auf
    // dem Hook-Pfad reiner Overhead.
    this.queryCache.set(key, {
      hits: hits.map((h) => ({ ...h })),
      pool: pool.map((h) => ({ ...h })),
      at: Date.now(),
      ...(degraded ? { degraded } : {}),
    });
  }

  private indexOne(m: Memory): void {
    const fm = m.fm;
    // #360: recall_when-DF-Map neu aufbauen — erst alte Terme dieser id
    // abziehen (no-op bei Erstindizierung), dann die aktuellen zählen. Deckt
    // add/change gleichermaßen ab, `remove` räumt in `handle()` separat auf,
    // weil dort kein neuer Stand mehr kommt.
    this.forgetRecallWhenTerms(fm.id);
    const recallWhenTerms = new Set(
      tokenizeWithIdentifiers(fm.recall_when.join(" ")).map((t) => t.toLowerCase()),
    );
    for (const t of recallWhenTerms) {
      this.recallWhenTermFreq.set(t, (this.recallWhenTermFreq.get(t) ?? 0) + 1);
    }
    this.recallWhenTermsByMemId.set(fm.id, recallWhenTerms);
    const doc: IndexDoc = {
      id: fm.id,
      title: fm.title,
      summary: fm.summary,
      tags_flat: fm.tags.join(" "),
      recall_when_flat: fm.recall_when.join(" \n "),
      recall_when_expanded_flat: (fm.recall_when_expanded ?? []).join(" \n "),
      topic_path_flat: fm.topic_path.join(" "),
      body: m.body,
      // Nur wenn eine Projektion geladen ist. Ein Memory ohne Cues bekommt das
      // Feld leer — es ist dann im Index vorhanden, trägt aber keine Terme.
      ...(this.cues
        ? { cues_flat: (this.cues.byMemory.get(fm.id) ?? []).join(" \n ") }
        : {}),
      type: fm.type,
      scope: fm.scope,
      topic_path: fm.topic_path,
      obsolete: fm.obsolete === true,
      confidence: fm.confidence ?? 1,
      // Default ist "team" (kommt aus dem zod-Schema), aber alte Files
      // ohne das Feld werden hier zu "team" defaultet damit der Filter
      // konsistent ist.
      sensitivity: (fm as { sensitivity?: string }).sensitivity ?? "team",
    };
    this.mini.add(doc);
  }
}

/**
 * Standard-Filter für BM25-Roh-Treffer: obsolete-Maskierung, scope/type-
 * Exact-Match (scope gefaltet über `scopeEquals`, #360-Folgefund — ein aus
 * dem Dateisystem erkannter Projektname trägt eine andere Schreibweise als
 * der im Vault gespeicherte Scope), und der neue Sensitivity-Filter (#58). Wird sowohl von
 * `recall` als auch von `recallHybrid` aufgerufen, damit der Filter an
 * einer Stelle gepflegt wird. `r` ist ein MiniSearch-`SearchResult`, das
 * via `storeFields` die gespeicherten Doc-Properties als beliebige
 * Keys mit-trägt — daher das `Record<string, unknown>`-Typing hier.
 */
function passesRecallFilters(
  r: Record<string, unknown>,
  opts: RecallOptions,
): boolean {
  if (r.obsolete) return false;
  if (opts.scope && !scopeEquals(r.scope as string, opts.scope)) return false;
  if (opts.type && r.type !== opts.type) return false;
  if (!opts.allow_private && r.sensitivity === "private") return false;
  return true;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// MARK: - Stage-Event-Emitter (#38)

/**
 * Hilfsklasse für Stage-Events in `recall` / `recallHybrid`. Hält den
 * optionalen Listener und liefert `start()`/`end()`/`emit()`. Bei
 * fehlendem Listener sind alle Methoden no-op und allokationsfrei
 * (kein `Date.now()` ohne Bedarf). Die Klasse lebt nur in `search.ts`,
 * weil sie tight an die Stage-Sequenz gekoppelt ist — die public Types
 * stehen in `recall-stages.ts`.
 */
class StageEmitter {
  constructor(private readonly listener?: StageListener) {}

  /** Start-Event feuern. Liefert den Start-Timestamp, der unverändert
   *  an `end()` zurückgegeben wird (so muss der Caller kein lokales
   *  `const t = Date.now()` aufmachen). */
  start(name: RecallStage["name"], meta?: Record<string, unknown>): number {
    if (!this.listener) return 0;
    const t = Date.now();
    this.listener({ name, startedAtMs: t, meta });
    return t;
  }

  /** Stop-Event feuern. `startedAt` ist der Rückgabewert von `start()`. */
  end(name: RecallStage["name"], startedAt: number, meta?: Record<string, unknown>): void {
    if (!this.listener) return;
    const dur = Date.now() - startedAt;
    this.listener({ name, startedAtMs: startedAt, durationMs: dur, meta });
  }

  /** One-shot-Event (kein separates Stop) — für `cache.hit`, `done`,
   *  `error`. `startedAtMs` ist der „Recall-Start" (für `done`) oder
   *  der Event-Zeitpunkt selbst. */
  emit(name: RecallStage["name"], startedAtMs: number, meta?: Record<string, unknown>): void {
    if (!this.listener) return;
    this.listener({ name, startedAtMs, durationMs: Date.now() - startedAtMs, meta });
  }
}

// MARK: - Lifecycle-Reranking (#74)

/**
 * Default-Verfallszeit pro Memory-Type. Identisch zu
 * `Sources/Bastra/MemoryLifecycle.swift:defaultExpirationDays` — bei
 * Änderungen beide Stellen mitziehen.
 * `null` = Type altert nie automatisch (Bookmarks, Documents,
 * Preferences, References).
 */
const DEFAULT_EXPIRATION_DAYS: Record<string, number | null> = {
  lesson: 180,
  decision: 365,
  "project-fact": 90,
  "meta-working": 365,
  workflow: 180,
  preference: null,
  "user-preference": null,
  reference: null,
  bookmark: null,
  doc: null,
};

const AGING_THRESHOLD_FRACTION = 0.75;

/**
 * Score-Multiplier basierend auf der Staleness (#74). Wird nach allen
 * anderen Filtern in `recall`/`recallHybrid` auf den finalen Hit-Score
 * angewandt — stale Memories ranken niedriger, expired noch niedriger.
 */
export type StaleStatus = "fresh" | "aging" | "stale" | "expired";

const STALE_MULTIPLIERS: Record<StaleStatus, number> = {
  fresh: 1.0,
  aging: 0.85,
  stale: 0.5,
  expired: 0.2,
};

/**
 * Curator-Demotion (#155): Score-Faktor für Memories, die der deterministische
 * Staleness-Pass demotet hat (surfaced-but-never-acted-on). Gleiche Liga wie
 * "stale": auffindbar, aber hinter engagierten Memories. Score-only per
 * survival-by-id-Vertrag (#146) — load_memory, Citations und die Datei selbst
 * bleiben unberührt; die Engine trägt nur den Mechanismus (setDemotions),
 * die Curation-Entscheidung lebt im Daemon.
 */
export const CURATOR_DEMOTION_MULTIPLIER = 0.5;

/**
 * Dämpfung für type="doc"-Hits im Default-Recall (kein expliziter type-
 * Filter). Docs altern nie (DEFAULT_EXPIRATION_DAYS: null) UND haben lange
 * Bodies — ohne Dämpfung würden Produkt-Doku und Document-Sidecars Lessons
 * aus den Top-k drängen. 0.5 = gleiche Liga wie "stale": auffindbar, aber
 * hinter frischen Memories. Mit type:"doc" (= find_document) volle Scores.
 */
export const DOC_TYPE_DAMPING = 0.5;

/**
 * #217 Valenz: begrenzter Salience-Multiplikator (1 + salience × CAP).
 * Default ist SHADOW-only — der Daemon loggt die would-be-Reihenfolge
 * (salience-shadow.ts), live wird erst via BASTRA_SALIENCE_RANK=live nach
 * Lift-Nachweis geschaltet (Disziplin wie #160). Env wird pro Aufruf
 * gelesen (testfreundlich), darf aber nie pro Request umgeschaltet werden —
 * der Query-Cache cached das post-staleness-Ranking.
 */
export function salienceRankCap(): number {
  const raw = Number(process.env.BASTRA_SALIENCE_RANK_CAP ?? "0.25");
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.25;
}

export function computeStaleness(
  fm: Record<string, unknown>,
  now: Date = new Date(),
): StaleStatus {
  const updated = parseDateValue(fm.updated);
  const lastReviewed = parseDateValue(fm.last_reviewed_at);
  const touch = Math.max(updated ?? 0, lastReviewed ?? 0);

  const validUntil = parseDateValue(fm.valid_until);
  if (validUntil != null) {
    if (now.getTime() >= validUntil) return "expired";
    // #365/14: unbekanntes `touch` (weder `updated` noch `last_reviewed_at`
    // parsebar) ist 0 = Unix-Epoche. `elapsed/total` misst dann den Abstand
    // zu 1970 statt zur letzten Bearbeitung und landet für jedes Ablaufdatum
    // nahe heute bei ≈0.99 → immer „aging". Der Zweig ohne `valid_until` hat
    // denselben Guard (unten, vor der Ratio) — beide müssen dasselbe sagen.
    if (touch <= 0) return "fresh";
    const total = validUntil - touch;
    const elapsed = now.getTime() - touch;
    if (total > 0 && elapsed / total >= AGING_THRESHOLD_FRACTION) {
      return "aging";
    }
    return "fresh";
  }

  const type = String(fm.type ?? "");
  const userOverride =
    typeof fm.expires_after_days === "number" ? (fm.expires_after_days as number) : null;
  const typeDefault =
    type in DEFAULT_EXPIRATION_DAYS ? DEFAULT_EXPIRATION_DAYS[type] : null;
  let days = userOverride ?? typeDefault;
  if (days == null || days <= 0) return "fresh";

  // #217 Valenz: hohe Salience altert langsamer — emotional aufgeladene
  // Memories verblassen zuletzt. salience 1 = doppelte Lebensdauer.
  // `valid_until` bleibt unberührt (explizites User-Datum gewinnt).
  const salience =
    typeof fm.salience === "number" ? Math.min(Math.max(fm.salience, 0), 1) : 0;
  if (salience > 0) days = days * (1 + salience);

  if (touch <= 0) return "fresh";
  const secondsSinceTouch = (now.getTime() - touch) / 1000;
  const staleSeconds = days * 86400;
  if (secondsSinceTouch <= 0) return "fresh";
  const ratio = secondsSinceTouch / staleSeconds;
  if (ratio >= 1.5) return "expired";
  if (ratio >= 1.0) return "stale";
  if (ratio >= AGING_THRESHOLD_FRACTION) return "aging";
  return "fresh";
}

function parseDateValue(raw: unknown): number | null {
  if (raw == null) return null;
  // YAML kann `2026-05-12` als Date entlocken — wir akzeptieren beides.
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string" && raw.length > 0) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * „Touch-Timestamp" einer Memory: jüngeres aus `updated` und
 * `last_reviewed_at`. Wird vom Staleness-Cache (#29) als Identitäts-
 * Stempel benutzt — ändert sich der touchTs, wird der Cache-Eintrag
 * neu berechnet, auch ohne Vault-Event (z.B. wenn die Mac-App die
 * Frontmatter direkt patcht).
 */
function computeTouchTs(fm: Record<string, unknown>): number {
  const updated = parseDateValue(fm.updated) ?? 0;
  const lastReviewed = parseDateValue(fm.last_reviewed_at) ?? 0;
  return Math.max(updated, lastReviewed);
}

/**
 * Wendet den Staleness-Multiplier auf einen Hit-Score an. Daemon nutzt
 * die `vault.get(id).fm` als Quelle für das Frontmatter — die Computation
 * läuft lazy beim Recall (kein File-Write).
 */
export function applyStalenessMultiplier(
  hits: RecallHit[],
  resolveFrontmatter: (id: string) => Record<string, unknown> | undefined,
  now: Date = new Date(),
): RecallHit[] {
  for (const h of hits) {
    const fm = resolveFrontmatter(h.id);
    if (!fm) continue;
    const status = computeStaleness(fm, now);
    const mult = STALE_MULTIPLIERS[status];
    if (mult !== 1.0) {
      h.score = round(h.score * mult);
    }
  }
  // Re-sort nach möglicher Score-Anpassung. Direct-Hits vor 1-hop-Hits
  // bleiben aber Gruppe — wir sortieren INNERHALB jeder Gruppe.
  const direct = hits.filter((h) => h.hop !== "1-hop");
  const hops = hits.filter((h) => h.hop === "1-hop");
  direct.sort((a, b) => b.score - a.score);
  hops.sort((a, b) => b.score - a.score);
  return [...direct, ...hops];
}
