/**
 * Die Datentypen der Recall-Pipeline (#1039): was ein Treffer trägt
 * (`RecallHit`), womit ein Aufruf gesteuert wird (`RecallOptions`) und wie ein
 * Memory im BM25-Index liegt (`IndexDoc`), plus die Cue-Optionen des Index.
 * Öffentlich bleiben sie über `search.ts`; `IndexDoc` ist intern und wird
 * dort nicht re-exportiert.
 */
import type { StageListener } from "./recall-stages.js";
import type { LateSettleSample } from "./deadline.js";
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
   * #489: Die SPÄTE Stichprobe eines aufgegebenen dichten Arms. Feuert nur nach
   * einem Timeout, und erst wenn der weiterlaufende Arm wirklich fertig ist —
   * also nachdem `recallHybrid` längst zurückgekehrt ist.
   *
   * Warum ein eigener Kanal und keine Stage: Der Wert kommt NACH `done` an. Ein
   * Stage-Event danach würde einen bereits geschlossenen Fortschrittsstrom
   * bedienen und der Banter-Engine einen Schritt nach dem Ende melden. Er ist
   * auch keine Wartezeit — niemand hat sie bezahlt (siehe `LateSettleSample`).
   *
   * Null-Overhead, wenn nicht gesetzt: ohne Listener hängt `abandonAfter` gar
   * keine Fortsetzung an.
   */
  onVectorLateSettle?: (sample: LateSettleSample) => void;
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

export interface IndexDoc {
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
