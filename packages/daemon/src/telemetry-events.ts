/**
 * Telemetry event types — the JSONL shapes the daemon's Telemetry class
 * writes. Split out of telemetry.ts (file-size convention): pure types, no
 * runtime code. telemetry.ts re-exports everything, so importers keep their
 * path.
 */
import type { SalienceShadow } from "./salience-shadow.js";
import type { TrustShadow } from "./trust-shadow.js";
import type { TelemetryDimensions } from "./telemetry-dimensions.js";
import type {
  OllamaLifecycleEvent,
  WarmupSettleEvent,
  VectorLateSettleEvent,
} from "./telemetry-events-embedding.js";

// Nur die Events, die DIESE Klasse via write() schreibt. Die Hook-CLIs
// (hook_call, session_hook_call, prompt_hook_call, bash_hook_call,
// bash_fail_hook_call, todo_hook_call, save_eval_call) sind eigene Prozesse
// und schreiben mit ihren eigenen lokalen Telemetry-Interfaces direkt ins
// JSONL — sie gehören NICHT in diese Union (sonst täuscht sie einen Producer
// vor, den es hier nicht gibt). Reader (stats.ts, harvest.ts) parsen roh.
export type TelemetryEvent =
  | RecallEvent
  | LoadMemoryEvent
  | SaveMemoryEvent
  | SaveHoldEvent
  | HookRecallEvent
  | HookReflexEvent
  | HookActEvent
  | RecallEpisodeEvent
  | HintFollowedShadowEvent
  | IdScanEvent
  | MutationIncidentEvent
  | EvidenceDecisionEvent
  | OllamaLifecycleEvent
  | WarmupSettleEvent
  | VectorLateSettleEvent
  | ReadDocumentEvent;

/**
 * Pro-Stage-Timings eines Recalls (#38) plus die Querykosten-Merkmale aus
 * #362 Phase 0.
 *
 * Bewusst EIN Typ für `recall_call` und `hook_recall`: Die beiden Listen
 * standen als Kopien nebeneinander, und eine Auswertung, die den Hook-Pfad
 * gegen den MCP-Pfad vergleicht, ist nur dann korrekt, wenn beide dieselben
 * Felder tragen. Eine Kopie zu erweitern und die andere zu vergessen fällt
 * nicht auf — die fehlende Zahl sieht aus wie ein alter Event.
 */
export interface RecallStageBuckets {
  query_parse_ms?: number;
  bm25_search_ms?: number;
  vector_search_ms?: number;
  /**
   * #489: Die WARTEZEIT des Aufrufers auf den dichten Arm — vom `await` bis
   * Settle oder Aufgabe.
   *
   * `vector_search_ms` daneben ist die Wanduhr des Arms ab dem Abfeuern und
   * überlappt `bm25_search_ms` (`overlapped: true`); die Stages sind seit #370
   * bewusst keine Partition des Totals. Gemessen 06.–08.09.2026 klaffen die
   * beiden Größen in der Prompt-Lane um zwei Größenordnungen auseinander:
   * `vector_search_ms` p50 336 ms, echte Wartezeit p50 5 ms — der Embed
   * versteckte sich hinter einem langen BM25-Lauf.
   *
   * Optional, weil Events vor #489 das Feld nicht haben. Fehlt es, ist die
   * Wartezeit UNBEKANNT — nicht null und schon gar nicht `vector_search_ms`.
   */
  vector_wait_ms?: number;
  rrf_fuse_ms?: number;
  hops_expand_ms?: number;
  staleness_rank_ms?: number;
  cache_hit?: boolean;
  /**
   * Wieviele Terme der lexikalische Arm emittiert hat und wieviele davon
   * eindeutig waren.
   *
   * Die Kosten des Arms folgen der TERMZAHL, nicht der Zeichenzahl — ein
   * 2000-Zeichen-Stacktrace mit lauter eindeutigen Pfaden ist teurer als 4000
   * Zeichen Fließtext mit vielen Wiederholungen. Der Abstand zwischen beiden
   * Zahlen ist genau das, was die Gruppierung (#362 Phase 1) einspart, und die
   * Grundlage, auf der ein kostenbasierter Router später entscheiden kann.
   */
  terms_emitted?: number;
  terms_unique?: number;
}

export interface BaseEvent {
  ts: string;
  session_id: string;
}

/**
 * Die Auswertungsdimensionen an einem Ereignis (#263, §17.4/§17.5).
 *
 * Optional im TYP, nicht in der Absicht: Jedes Ereignis, das ein Produzent ab
 * jetzt schreibt, trägt sie (`telemetry.ts` füllt sie zentral). Optional ist
 * das Feld, weil die JSONL-Dateien mit den Ereignissen VOR dieser Änderung
 * weiterlebt werden — ein Leser muss „Spalte fehlt" von „Spalte sagt unknown"
 * unterscheiden können. Das eine heißt „vor #263 geschrieben", das andere
 * „Oberfläche hat sich nicht ausgewiesen".
 */
export interface DimensionedEvent {
  dimensions?: TelemetryDimensions;
}

/** Shared learned-recall (#120): the bridge expansion applied to a recall query.
 *  Absent when the layer is off or no bridge matched — so its presence and the
 *  `added` count are the metric for how often and how much bridges fired. */
export interface BridgeExpansion {
  lang: string;
  added: string[];
}

export interface RecallEvent extends BaseEvent, DimensionedEvent {
  kind: "recall";
  recall_id: string;
  query: string;
  /** #351: set when this recall is one phrasing of a batched call — the
   *  batch width (2-4). Absent on plain single-query recalls. */
  query_count?: number;
  /** #351 guard: highest pairwise content-token overlap across the batch's
   *  submitted queries — measures how paraphrase-shaped batches really are. */
  batch_overlap?: number;
  /** #351 guard: near-duplicate queries collapsed before searching. */
  batch_collapsed?: number;
  k: number | null;
  scope: string | null;
  type: string | null;
  vault_size: number;
  hit_count: number;
  top_score: number | null;
  /** #263: `hop` trägt die Herkunft des Treffers — `direct` oder `1-hop`.
   *  §18.2 braucht sie für das M1-Umschaltgate („der Report zeigt die
   *  Hop-Herkunft der required-Hits"), und der Evidenzentscheid aus #264 darf
   *  einen nur über einen Graph-Hop erreichten Treffer nicht allein als
   *  `required` führen. Optional, weil der reine BM25-Pfad ohne Hop-Expansion
   *  nichts zu melden hat. Die schlanke Hook-Projektion bleibt unberührt —
   *  das hier ist Telemetrie, kein Teil des öffentlichen Vertrags (C-046). */
  hits: { id: string; score: number; type: string; hop?: "direct" | "1-hop" }[];
  latency_ms: number;
  /**
   * Pro-Stage-Timings (#38). Optional — alte Events ohne Stage-Emitter
   * haben das Feld nicht. `cache_hit: true` zeigt einen Query-Cache-Hit,
   * dann fehlen die übrigen Stage-Felder (außer query_parse_ms).
   */
  recall_stages?: RecallStageBuckets;
  /**
   * Anzahl Hits, die unter dem Score-Floor (#50 / #9) lagen und nicht
   * zurückgegeben wurden. Macht die Wirkung des Floors messbar. Optional —
   * alte Events ohne Floor-Logik haben das Feld nicht.
   */
  dropped_below_floor?: number;
  /** Shared learned-recall (#120): bridge expansion applied to this query, if any. */
  bridge_expansion?: BridgeExpansion;
  /** #121: the deeper candidate pool (incl. below-floor ranks) behind this recall,
   *  so the far slice is observable for offline harvesting. Lean {id, score} only. */
  candidate_pool?: { id: string; score: number }[];
  /**
   * Zweiter Gegenreview: In welchem Raum `top_score` und `hits[].score` liegen
   * — `"rrf"` = fusionierte Rang-Summe, die Bänder 30/50/100 beschreiben
   * etwas; `"bm25"` = roher, nach oben offener MiniSearch-Wert, die Bänder
   * beschreiben nichts. Ohne dieses Feld ist jede Auswertung über `top_score`
   * eine Zahl ohne Skala, und die Floor-Kalibrierung lernte aus rohen
   * Sechsstellern „starke" und aus fusionierten 60ern „schwache" Fälle.
   * Optional: ältere Events haben es nicht — ein fehlender Wert heißt
   * „unbekannt", nicht „rrf".
   */
  score_kind?: "rrf" | "bm25";
  /** Der Raum von `candidate_pool`, SEPARAT geführt: Bei aktiven Commons kommt
   *  der Pool aus der persönlichen Suche und `top_score` aus der Liste nach der
   *  Commons-Runde — die beiden können auseinanderfallen. */
  candidate_pool_score_kind?: "rrf" | "bm25";
  /**
   * Die ARMMENGE und die FORMELVERSION des `candidate_pool` — dieselbe volle
   * Signatur, die `score_arms`/`score_version` für `top_score` tragen.
   *
   * Codex-Gegenreview (P1): Der Pool trug nur seinen `score_kind`. Gemessen:
   * `top_score: 150` aus drei Armen (bm25+commons+vector) gegen einen Pool mit
   * Spitzenwert 80 aus zwei Armen (bm25+vector) — beide meldeten `"rrf"`, also
   * hielt `extractCandidatePools()` sie für denselben Raum und las 150 als
   * Pool-Score. Ein schwacher persönlicher Recall wurde damit nie zum
   * Bridge-Reranking geschickt. `score_kind` allein reicht nicht; nur Kind +
   * Version + Armmenge zusammen bestimmen den Raum.
   *
   * Optional: ältere Events haben die Felder nicht — ein fehlender Wert heißt
   * „unbekannt", nicht „gleich wie top_score".
   */
  candidate_pool_score_arms?: string[];
  /** Version der Pool-FORMEL. Wie beim Haupt-Score NUR auf einer fusionierten
   *  Skala gesetzt — auf rohem BM25 gibt es keine Formel, deren Version man
   *  nennen könnte, und eine dort hingeschriebene Version ließe zwei
   *  unvergleichbare Räume vergleichbar aussehen. */
  candidate_pool_score_version?: string;
  /**
   * Welche ARME den ausgelieferten Score gebildet haben, sortiert.
   *
   * Codex-Gegenreview (P0): `score_kind: "rrf"` steht für mehrere verschiedene
   * Zahlen — BM25+Vector, BM25+Commons, Vector+Commons, Hop+Commons. Die
   * Obergrenze unterscheidet sich (163.934 gegen 241.803), also sind zwei
   * `rrf`-Werte nur dann vergleichbar, wenn ihre Armmenge identisch ist. Für
   * die Auswertung ist das die entscheidende Dimension, nicht `score_kind`.
   */
  score_arms?: string[];
  /** Version der Score-FORMEL. Ohne sie wäre eine spätere Formeländerung
   *  historisch nicht auswertbar: Zwei Zeilen mit derselben Armmenge sähen
   *  vergleichbar aus, obwohl die Zahl dazwischen ihre Bedeutung geändert
   *  hat. Nur auf fusionierten Antworten gesetzt — auf einer rohen Skala gibt
   *  es keine Formel, deren Version man nennen könnte. */
  score_version?: string;
  /** #249: no hit lexically anchored — the hybrid score was rank-1-of-nothing.
   *  Recorded, not just returned: without it a stats run reports zero weak
   *  recalls on every vault, which reads as health and is actually silence. */
  weak_result?: boolean;
  /** #230: stricter than weak_result — the top hit lives in one arm only, the
   *  shape a genuinely absent fact takes. Strict subset, so no_home implies
   *  weak_result. Recorded to make the no-home rate measurable at all. */
  no_home?: boolean;
  /** #165: served BM25-only because the embedding circuit breaker was open
   *  (no embed attempt). Absent = healthy hybrid or embeddings off — lets
   *  stats separate degraded from normal recalls. */
  embedding_degraded?: boolean;
  /** #342: served BM25-only because a leg of the hybrid dropped out, and which
   *  one. `vector-arm-timeout` = the dense arm missed its per-arm deadline
   *  (#305: a cold embedding model costs ~590ms it cannot make up); the embed
   *  is left running so the next call is warm. `vector-arm-empty` = the arm
   *  returned nothing, which predates the deadline.
   *
   *  Distinct from `embedding_degraded`: that one means no embed was attempted
   *  at all (breaker open). This one means it was attempted and abandoned — the
   *  two have different fixes, so counting them as one number hides both. */
  degraded_reason?: string;
  /** #217: would-be re-ranking under the salience multiplier (shadow mode).
   *  Absent when no served hit carries salience or the mode isn't shadow. */
  salience_shadow?: SalienceShadow;
  /** #160: would-be re-ranking under the usage-driven trust multiplier
   *  (shadow mode). Absent when every served hit sits at the trust ceiling —
   *  i.e. nothing has been shown-and-ignored — or the mode isn't shadow. */
  trust_shadow?: TrustShadow;
  /**
   * #457: Größe des Payloads, den der Aufrufer tatsächlich bekommen hat —
   * das serialisierte Ergebnis (pretty JSON, wie MCP und Forwarder es in den
   * Transkript-Text schreiben). Tokens sind chars/4, derselbe Schätzer wie
   * `hint_tokens_est` in den Hook-Lanes. Kein Rohtext. Alte Zeilen ohne das
   * Feld zählen im Ledger als `unknown`, nie als 0.
   */
  payload_chars?: number;
  payload_tokens_est?: number;
  presentation?: "lean" | "full";
  /**
   * #487: Das ANGEFORDERTE Kontextbudget dieses Aufrufs in Token. Fehlt, wenn
   * der Aufrufer keines gesetzt hat. Zusammen mit `payload_tokens_est` (was
   * wirklich ausging) ist das die Zuordnung, die #457 für die Ersparnis
   * braucht — eine der beiden Zahlen allein sagt sie nicht.
   */
  max_tokens?: number;
  /** #487: wie viele gerankte Treffer das Budget weggelassen hat. Fehlt, wenn
   *  keiner fiel; die ausgespielte Zahl ist `hit_count` minus dieser Wert. */
  dropped_by_budget?: number;
}

/** #457: Woher ein Load kam — Hook-Hint, eigener `recall()` oder kalt. */
export type LoadOrigin = "hook" | "recall" | "direct";

export interface LoadMemoryEvent extends BaseEvent {
  kind: "load_memory";
  id: string;
  found: boolean;
  follows_recall: string | null;
  /** recall_id of a recent hook_recall whose hits[] contained this id, if any. */
  from_hook_recall: string | null;
  /** Rank (1-based) at which this id appeared in that hook_recall's hits[]. */
  hook_hint_rank: number | null;
  /**
   * #457: Größe des tatsächlich gelieferten Payloads NACH der lean/full-
   * Projektion (nicht die Vault-Datei). `delivered_chars` ist das
   * serialisierte Ergebnis, `body_chars` nur der Body-Anteil. Nur auf
   * erfolgreichen Loads; fehlt auf alten Zeilen → `unknown` im Ledger.
   */
  delivered_chars?: number;
  delivered_tokens_est?: number;
  body_chars?: number;
  presentation?: "lean" | "full";
  origin?: LoadOrigin;
  /** #457: Echte Session des Aufrufers (Forwarder-Header), wenn bekannt. */
  caller_session?: string | null;
}

/** #457: `read_document` liefert ganze Dokumentkörper — der größte
 *  einzelne Posten, der bisher in keiner Kontextrechnung stand. */
export interface ReadDocumentEvent extends BaseEvent {
  kind: "read_document";
  id: string;
  found: boolean;
  delivered_chars?: number;
  delivered_tokens_est?: number;
  body_chars?: number;
  caller_session?: string | null;
}

/** #469: `not_hinted` = the load had no hook hint and therefore no score —
 *  there was never a floor for it to be below. Before, such episodes were
 *  filed as `below_floor` and every readout counted them as ranking failures. */
export type RecallBand = "required" | "optional" | "below_floor" | "not_hinted";
export type TurnSource = "session" | "inferred";

export interface RecallEpisodeEvent extends BaseEvent {
  kind: "recall_episode";
  turn_id: string;
  turn_source: TurnSource;
  recall_id: string | null;
  memory_id: string;
  surfaced_score: number | null;
  band: RecallBand;
  /** true = der Load folgte einem Hook-Hint (#77). false = Direkt-Load ohne
   *  Hint — zählt NICHT in die USE-rate (sonst mischt das below_floor-Band
   *  zwei fremde Populationen). Ersetzt das frühere, immer-wahre `loaded`. */
  surfaced: boolean;
  acted_on: boolean;
  match_strength: number;
  tool_name: string | null;
}

/**
 * #478 Part 2 / #484 shadow: did an injected hint get FOLLOWED without ever
 * being loaded? `acted_on` can only ever answer that for an explicit
 * `load_memory` — the breaker in `hint-suppression.ts:93` therefore treats an
 * unobservable signal as evidence of worthlessness.
 *
 * Deliberately its OWN kind rather than a field on `RecallEpisodeEvent`:
 * `telemetry-report.ts:184-188` counts every surfaced episode as `loaded`, so
 * emitting these as episodes would inflate the USE rate — a measurement that
 * changes the numbers it measures. Nothing reads this kind yet; it is a
 * parallel count for the 10.09. evaluation.
 *
 * NO recall_id, score or band: `hookHints` keeps one slot per memory id and
 * the newest recall overwrites it, so any provenance here would be the wrong
 * recall's as often as not (review finds, Vera 06.09.). The question — was an
 * injected hint followed — needs none of it.
 *
 * READ IT AS AN UPPER BOUND. A hint is injected BECAUSE it fits the context,
 * so its words are more likely to appear in the next tool input anyway. Where
 * `loaded` is a lower bound for "used", this is a ceiling.
 */
export interface HintFollowedShadowEvent extends BaseEvent {
  kind: "hint_followed_shadow";
  memory_id: string;
  turn_id: string;
  turn_source: TurnSource;
  /** Same threshold as `acted_on` (>= 2) so both numbers stay comparable. */
  followed: boolean;
  match_strength: number;
  tool_name: string | null;
  /** ms between the hint being injected and this tool input. */
  age_ms: number;
}

export interface SaveMemoryEvent extends BaseEvent {
  kind: "save_memory";
  id: string;
  type: string;
  scope: string;
  title: string;
  tag_count: number;
  recall_when_count: number;
  body_chars: number;
  overwrite: boolean;
  created: boolean;
  follows_recall: string | null;
}

/**
 * #477 — a save that never became a write.
 *
 * `save_memory` has four exits above the write: the claim gate holds a create
 * whose triggers a memory already owns, a `conflict_with` payload is diverted
 * into a conflict block, an unresolved `replaces` throws, and an existing id
 * without `overwrite` throws. None of them reached `logSaveMemory`, so the
 * ledger only ever showed saves that succeeded and the hold rate was not
 * derivable from it at all — see #376, which cannot be evaluated without a
 * baseline of how often the gate currently bites.
 *
 * Deliberately carries NO content: no title, no body, no trigger text. What a
 * save wanted to say is the user's, and a rejected one says it just as much as
 * an accepted one.
 */
export interface SaveHoldEvent extends BaseEvent {
  kind: "save_hold";
  /** Which exit fired. `claim_gate` is the only one that is not an error. */
  reason:
    | "claim_gate"
    | "conflict_redirect"
    | "unresolved_replaces"
    | "id_exists"
    /** #464: the target is a private memory this caller may not even read. */
    | "private_refused";
  id: string;
  type: string;
  scope: string;
  /** Memories the claim gate found unanswered; 0 for every other reason. */
  claimed_count: number;
  overwrite: boolean;
  follows_recall: string | null;
}

/** #144: lightweight act-signal from the PostToolUse:Bash hook — no recall,
 *  no injection; only widens the acted_on measuring surface so shell-driven
 *  applications of a memory can close their recall_episode. */
/**
 * Was ein autoritativer ID-Scan gekostet hat.
 *
 * Der Scan ist der Preis der Invariante „eine ID, eine Datei, ein
 * transaktionaler Writer": Jeder besitzverändernde Writer liest dafür jede
 * Markdown-Datei des Vaults. Lokal auf APFS ist das zweistellig in
 * Millisekunden — auf einem Cloud-Mount oder in einem großen Obsidian-Vault
 * ist es eine offene Frage, und der Preis hängt an der Gesamtzahl ALLER
 * Markdown-Dateien, nicht an der Zahl der indexierten Memories.
 *
 * Deshalb misst der Daemon ihn dauerhaft statt einmal: `ms` gegen `files` und
 * `bytes` gestellt zeigt, ob eine Verlangsamung vom Vault oder vom Mount kommt,
 * und `blind_spots` sagt, ob der Scan überhaupt vollständig war.
 */
export interface IdScanEvent extends BaseEvent {
  kind: "id_scan";
  /** Die id, für die gescannt wurde. */
  id: string;
  /** Der Writer, der den Scan ausgelöst hat (`save_memory`, `save_document`,
   *  `archive`, …) — sonst lassen sich Create, Update und Import nicht
   *  getrennt auswerten. */
  op: string;
  ms: number;
  files: number;
  bytes: number;
  dirs: number;
  blind_spots: number;
  /** Liegt der Vault auf einem Cloud-Provider-Mount? Die Latenz dort ist eine
   *  andere Größenordnung, und beide Verteilungen in einen Topf zu werfen
   *  verwischt genau den Unterschied, um den es geht. */
  cloud_mount: boolean;
}

/**
 * Was bei einer Mutation schiefging (#377).
 *
 * Der Grund, warum es diesen Event gibt: Ein Rollback, der nicht vollständig
 * durchkam, ein Audit-Append nach dem Commit, ein Area-Konflikt — nichts davon
 * hinterließ eine strukturierte Spur. Der Halbzustand einer Dokument-Operation
 * stand nur im TEXT einer Fehlermeldung, und die ist nach dem nächsten
 * Terminalfenster weg.
 *
 * KEINE Memory-Inhalte, keine Frontmatter-Werte, keine absoluten Pfade. Die id
 * ist der Schlüssel, an dem man im Audit-Log weitersucht; `detail` ist ein
 * kurzer, kontrollierter Grund und ausdrücklich keine durchgereichte
 * Fehlermeldung (die trägt regelmäßig Pfade).
 */
export interface MutationIncidentEvent extends BaseEvent {
  kind: "mutation_incident";
  /** Hält eine Mutation über ihre Phasen zusammen. */
  operation_id: string;
  /** Welcher Writer: `save_memory_refile`, `audit_delete`, `area_exclusive`, … */
  op: string;
  /** `committed` | `rolled_back` | `partial` | `conflict` | `audit_failed` |
   *  `reclaimed`. Die sechs verlangen verschiedene Reaktionen: `conflict` ist
   *  wiederholbar, `audit_failed` bedeutet „steht schon, NICHT wiederholen",
   *  und `partial` ist der einzige, der einen Menschen braucht. `reclaimed`
   *  berichtet über einen FRÜHEREN, gestorbenen Schreibvorgang und gehört
   *  deshalb in keine Quote der laufenden Operation. */
  status: string;
  /** Wo in der Operation: `publish`, `refile-trash`, `audit`, `rollback`,
   *  `area-claim`, `area-claim-readers`, `claim-reclaim`,
   *  `reader-marker-release`, `area-claim-late-source`. */
  phase: string;
  memory_id: string | null;
  /** Wie weit ein Rollback kam — `null`, wo keiner nötig war. */
  rollback: string | null;
  detail: string | null;
}

/**
 * Der Evidenzentscheid je Treffer, im SCHATTEN (#264, §10.1/§10.3, §10.4 Stufe 2).
 *
 * Der Entscheid läuft serverseitig, bevor die Antwort projiziert wird — dort
 * trägt ein Treffer noch seine Hop-Herkunft (C-046) —, und er wirkt in dieser
 * Stufe auf NICHTS: Die Antwort ist dieselbe, ob dieses Event geschrieben wird
 * oder nicht. Was hier steht, ist die Beobachtung, aus der später eine
 * Freigabe wird (§18.2: 14 Tage oder 500 geloggte Hook-Entscheidungen).
 *
 * DIE TRENNUNG, die dieses Event trägt (C-052/C-056/C-061): Das `no_answer`
 * hier ist das aus §10.3 — „die vorhandene Evidenz reicht für keine
 * Ausspielung". Es ist NICHT das `no_answer` des Deep-Recall-Ergebnisvertrags
 * (§8.5), das eine deterministisch erschöpfte Suche behauptet. Die beiden
 * werden nie ineinander übersetzt und nie gegeneinander verrechnet. Deshalb
 * eine eigene Ereignisklasse mit eigenem Namen: Ein gemeinsames Feld wäre die
 * Einladung, sie zu addieren.
 *
 * WAS NIE HINEINGEHÖRT (#377-Muster): keine Memory-Inhalte, keine
 * Frontmatter-Werte, keine Pfade, keine Query-Rohtexte. Die `memory_id` ist der
 * Schlüssel für die Weitersuche; die Evidenzmerkmale sind Zahlen, Wahrheitswerte
 * und ein kurzer Statuswert.
 */
export interface EvidenceDecisionEvent extends BaseEvent, DimensionedEvent {
  kind: "evidence_decision";
  /** Join-Schlüssel zum `hook_recall`-Event desselben Aufrufs. */
  recall_id: string;
  /** Immer `true`, solange der Entscheid im Schatten läuft. Ein Leser muss
   *  Schatten- von Wirkbetrieb trennen können, ohne das Datum zu kennen. */
  shadow: boolean;
  /**
   * Der Retrievalpfad war unvollständig (Deadline, ausgefallener Arm).
   *
   * Trägt die Auflage aus C-047/C-052: Ein Budget-Abbruch ist KEINE Abstention.
   * Wer die Abstentionsquote rechnet, muss die Läufe ausschließen können, in
   * denen weniger Evidenz vorlag, WEIL abgebrochen wurde — sonst zählt er den
   * Abbruch als Urteil.
   */
  degraded: boolean;
  /**
   * Der Entscheid selbst ist gescheitert (Defekt, keine Aussage).
   *
   * Dann ist `decisions` leer und `counts` sind null: Ein Controller-Defekt
   * geht weder in die Abstentions- noch in die Erfolgsstatistik ein
   * (C-047/C-052). Sichtbar bleibt er trotzdem — sonst wäre ein kaputter
   * Entscheid von einem Aufruf ohne Treffer nicht zu unterscheiden.
   */
  failed?: boolean;
  decisions: Array<{
    memory_id: string;
    /** `required` | `optional` | `no_answer` (§10.3). */
    decision: string;
    abstain_reason?: string;
    evidence: {
      exact_identifier: boolean;
      recall_when_coverage: number;
      lexical_rank?: number;
      lexical_score?: number;
      vector_rank?: number;
      arm_agreement: boolean;
      scope_match: boolean;
      temporal_status: string;
    };
    /** #263/§18.2: die Hop-Herkunft am Entscheid, damit der Report zeigen kann,
     *  worüber die `required`-Hits erreicht wurden (C-046). */
    hop?: string;
  }>;
  /** Die Zählung dieses Aufrufs — Grundlage der Shadow-Acceptance. */
  counts: { required: number; optional: number; no_answer: number };
}

export interface HookActEvent extends BaseEvent, DimensionedEvent {
  kind: "hook_act";
  tool_name: string | null;
  excerpt_chars: number;
  /** How many open loadedMemories episodes this act-signal closed. */
  matched_episodes: number;
  exit_code: number | null;
}

/** Recall served from the HTTP /hook/recall endpoint (server-side view). */
/**
 * #491 — Prognose gegen Wirklichkeit für den dichten Arm, pro Recall.
 *
 * Reine Beobachtung. Die Felder sind so gewählt, dass die Auswertung am
 * 13.09.2026 (#492) ohne Nacharbeit läuft: Jede Zeile trägt die Prognose, die
 * Zahl die galt, die Dimension in der sie stand, den Deckelungsgrund und —
 * sobald sie feststeht — die Wirklichkeit.
 */
export interface DeadlineShadowRow {
  /** `provider:model`, für das dieses Profil gilt. Ein Modellwechsel startet
   *  ein frisches; der Schlüssel ist die Stelle, an der man das sieht. */
  profile_key: string;
  /** Die Frist, die das gelernte Profil gesetzt hätte, ab dem `await`. */
  predicted_deadline_ms: number;
  /** Die Frist, die tatsächlich galt. */
  deadline_ms: number;
  /** Warum die Prognose so aussieht — insbesondere, ob die Wanduhr der Lane
   *  sie gedeckelt hat (`lane-wall-clock`) oder das Profil noch leer war
   *  (`profile-empty`, also einmal lexikalisch). #494: `lane-too-short` heißt
   *  `predicted_deadline_ms: 0` — unter der Mindestfrist läuft KEIN dichter
   *  Arm, statt einer Frist, die länger wäre als die Wanduhr. */
  cap_reason: "profile-empty" | "lane-wall-clock" | "lane-too-short" | "floor" | "max-deadline" | "none";
  /**
   * Auf welcher Ebene des hierarchischen Rückfalls die Zahl steht — eine grobe
   * Prognose darf nicht wie eine feine aussehen.
   *
   * `profile-wide` steht nur auf Zeilen VOR #493: Damals griff der Rückfall
   * über alle Eimer des Profils und damit über die Residenzgrenze, wodurch die
   * ersten kalten Stichproben das warme ~70-ms-Profil erbten. Solche Zeilen
   * gehören aus einer Kaltstart-Auswertung heraus.
   */
  basis: "bucket" | "length-wide" | "residency-wide" | "profile-wide" | "empty";
  /** Wieviele Stichproben sie trägt. */
  samples: number;
  /** Das p95 der GESAMTZEIT (Abfeuern → echtes Settle), aus dem sie stammt. */
  expected_total_ms?: number;
  /** Der Dimensions-Eimer: `residenz|längenband|nebenläufigkeit`. */
  bucket: string;
  /** Residenz beim Abfeuern, aus dem Warmup-Koordinator (#490). */
  residency: "warm" | "cold" | "unknown" | "hosted";
  /** Dichte Arme in Flug, inklusive dieses. */
  concurrency: number;
  /** Zeichen der Query, die der dichte Arm bekam (ungekappt). */
  query_chars: number;
  /** Was der Arm im Schatten von BM25 schon verbraucht hatte
   *  (`vector_search_ms − vector_wait_ms`, #489). */
  overlap_ms: number;
  /** Die Wanduhr der Lane, gegen die gedeckelt wurde. `0` = kein Budget. */
  lane_budget_ms: number;
  /** Ist der Arm an der TATSÄCHLICH geltenden Frist gescheitert? */
  timed_out: boolean;
  /** Die echte Gesamtzeit — nur wenn der Arm im Aufruf settelte. Beim
   *  aufgegebenen Arm steht sie in `vector_late_settle` (#489). */
  actual_settle_ms?: number;
  /**
   * #495: Hätte das Profil überhaupt einen dichten Arm GESTARTET?
   *
   * #499: Seit dieser Runde konstant `true`, und das ist kein Schönreden,
   * sondern die Korrektur eines Denkfehlers. Der dichte Arm wird VOR BM25
   * abgefeuert; die Prognose entsteht danach und kann ihn nicht mehr
   * verhindern. Eine Schattenzeile ohne Arm gibt es zudem gar nicht — ohne
   * Provider, mit offenem Breaker oder bei `lexical_only` (#494) wird keine
   * gebaut. Das Feld bleibt, weil die Auswertung des laufenden Fensters es
   * liest; die Unterscheidung, die es sein wollte, heißt jetzt
   * {@link DeadlineShadowRow.shadow_would_wait}.
   */
  shadow_would_run: boolean;
  /**
   * #499: Hätte das Profil an dieser Stelle noch GEWARTET?
   *
   * `false` = nein (`predicted_deadline_ms: 0`, `cap_reason:
   * "lane-too-short"`): Der Arm läuft, die gelernte Politik hätte ihn aber
   * nicht mehr abgewartet, sondern spät auslaufen lassen. Bis #499 stand
   * dieser Fall als `shadow_would_run: false` in der Zeile und trug keinen
   * `shadow_timeout` — 3 von 21 Zeilen der ersten Messnacht fielen damit aus
   * Kriterium 4 heraus, obwohl alle drei unter der festen Zahl fusioniert
   * hatten.
   */
  shadow_would_wait: boolean;
  /** Hätte die GELERNTE Frist gehalten? `true` = sie wäre gerissen. Zusammen
   *  mit `timed_out` ist das der direkte Vergleich der beiden Timeout-Quoten,
   *  den Kriterium 4 aus #492 verlangt. #499: Steht auf JEDER im Aufruf
   *  gesettelten Zeile, auch bei `shadow_would_wait: false` — dort heißt
   *  `true`, dass die gelernte Politik diese Fusion verloren hätte. Fehlt nur
   *  beim aufgegebenen Arm, dessen Wirklichkeit erst in `vector_late_settle`
   *  feststeht. */
  shadow_timeout?: boolean;
  /**
   * #493: Wie der dichte Arm ausgegangen ist.
   *
   * `hits` ist die EINZIGE Latenzstichprobe. Vorher fing `EmbeddingIndex
   * .search()` jeden Providerfehler ab und gab `[]` zurück; für `abandonAfter`
   * war das ein `settled: true`, also lernte das Profil die Dauer eines
   * HTTP 500 als „normalen dichten Arm". Fehlt auf Zeilen vor #493 und beim
   * aufgegebenen Arm — dessen Ausgang steht in `vector_late_settle`.
   */
  provider_outcome?: "hits" | "empty" | "error";
  /** Rohe Treffer des Providers, VOR dem Vault-Filter. Die gefilterte Zahl
   *  bleibt `recall_stages`-seitig, wo sie immer stand. */
  vector_hit_count?: number;
  /** GRUNDWAHRHEIT für Tor 3 aus #492: Der Provider hat für diesen Call ein
   *  Modell geladen (Ollama `load_duration`). Ohne dieses Feld musste „echter
   *  Kaltstart" aus Zeitstempeln erschlossen werden. */
  cold_start_observed?: boolean;
  /** Die gemeldete Ladezeit, roh in ms — damit die Kaltstartschwelle
   *  (`PROVIDER_COLD_LOAD_MS`) aus den Daten selbst nachgezogen werden kann. */
  provider_load_ms?: number;
  /** #493: Woher die Residenz stammt und ob sie geschätzt ist. Tor 3 darf auf
   *  geschätzten Zeilen nicht zählen. */
  residency_source?: "unload-observed" | "provider-load" | "warm-up" | "last-ok" | "hosted" | "none";
  residency_estimated?: boolean;
  /**
   * #493: Woher `lane_budget_ms` kommt.
   *
   * Live belegt: Die MCP-Lane wurde gegen eine fremde Wanduhr geschattet —
   * der Forwarder schickte kein `hook_budget_ms`, die Route fiel auf die 200
   * der Prompt-Lane zurück, und ein gesunder 400-ms-Arm las
   * `cap_reason: floor` gegen ein Budget, das für ihn nie galt. Seit #493
   * schickt jede Lane ihre eigene Zahl, und diese Spalte sagt, ob das
   * geschehen ist.
   */
  budget_source?: "caller" | "endpoint-default";
  /** #493: die datensparsame Kennung dieses Hosts (`host-profile.ts`) — Tor 5
   *  aus #492 fragt nach einer zweiten Maschine, und zusammengeführte Logs
   *  konnten Hosts vorher nicht auseinanderhalten. */
  host_profile_id?: string;
}

export interface HookRecallEvent extends BaseEvent, DimensionedEvent {
  kind: "hook_recall";
  recall_id: string;
  /**
   * #493: Die Klammer um die Recalls EINES Sitzungsstarts.
   *
   * Ein SessionStart feuert bis zu drei korrelierte Recalls (user-preference,
   * all-projects, Projekt-Scope) — jeder mit eigener `recall_id` und, auf
   * einem kalten Modell, jeder mit eigenem Kaltstart-Verdacht. Ohne diese
   * Klammer ist „20 Kaltstarts" (Tor 3 aus #492) nicht von „7 Kaltstarts × 3
   * Recalls" zu unterscheiden, und die `session_id` hilft nicht: Sie ist über
   * die ganze Sitzung dieselbe, also über beliebig viele Starts hinweg
   * (compact/clear/resume behalten sie).
   *
   * Fehlt auf jedem Recall, der nicht aus einem Sitzungsstart kommt — und auf
   * Zeilen vor #493.
   */
  session_start_call_id?: string;
  /**
   * #305/#361: der Turn, in dem dieser Recall lief — und woher die Zuordnung
   * stammt.
   *
   * `session_id` beantwortet keine Frage auf Turn-Ebene. „Wie oft reißt der
   * ERSTE Recall eines Turns seine Deadline" ist genau die Größe, an der die
   * Wirkung des Vorwärmens hängt, und ohne die Turn-Grenze musste jede solche
   * Auswertung sie aus Zeitstempeln raten. `turn_source: "inferred"` sagt,
   * dass die Zuordnung erschlossen ist — solche Zeilen gehören aus einer
   * strengen Auswertung heraus.
   *
   * Optional, weil die Ereignisse davor sie nicht tragen: Ein fehlendes Feld
   * heißt „vor dieser Änderung geschrieben", nicht „kein Turn".
   */
  turn_id?: string;
  turn_source?: TurnSource;
  query: string;
  /** #351: set when this recall is one phrasing of a batched call (2-4). */
  query_count?: number;
  topics: string[];
  tool_name: string | null;
  project: string | null;
  k: number;
  scope: string | null;
  type: string | null;
  vault_size: number;
  hit_count: number;
  top_score: number | null;
  /** #263: `hop` trägt die Herkunft des Treffers — `direct` oder `1-hop`.
   *  §18.2 braucht sie für das M1-Umschaltgate („der Report zeigt die
   *  Hop-Herkunft der required-Hits"), und der Evidenzentscheid aus #264 darf
   *  einen nur über einen Graph-Hop erreichten Treffer nicht allein als
   *  `required` führen. Optional, weil der reine BM25-Pfad ohne Hop-Expansion
   *  nichts zu melden hat. Die schlanke Hook-Projektion bleibt unberührt —
   *  das hier ist Telemetrie, kein Teil des öffentlichen Vertrags (C-046). */
  hits: { id: string; score: number; type: string; hop?: "direct" | "1-hop" }[];
  /** #479: candidates removed from automatic injection after repeated
   *  version-local surfaces with no explicit load. Never includes content. */
  usage_suppressed?: Array<{
    id: string;
    type: string;
    surfaced: number;
    tokens_est: number;
  }>;
  /** Sum of the lean-hit token estimates above (chars/4). */
  usage_suppressed_tokens_est?: number;
  /** #484: whether the list above was actually removed (`live`) or only
   *  counted (`shadow`). Absent on events written before the mode existed —
   *  those are live by definition. */
  usage_suppressed_mode?: "shadow" | "live";
  /**
   * #487: das angeforderte Kontextbudget dieses Aufrufs in Token, und was das
   * ausgelieferte Payload davon gebraucht hat. Dieselben Zahlen wie auf dem
   * MCP-Pfad — der Forwarder proxyt `recall` über diesen Endpunkt, also
   * entstünde die Ersparnis sonst genau dort, wo sie niemand messen kann.
   *
   * Nur auf Aufrufen MIT Budget: Die Größe zu messen heißt, das Payload ein
   * zweites Mal zu serialisieren, und dieser Endpunkt läuft an jedem Bash und
   * jedem Edit. Wer kein Budget schickt, zahlt die Messung nicht.
   */
  max_tokens?: number;
  dropped_by_budget?: number;
  payload_chars?: number;
  payload_tokens_est?: number;
  latency_ms_recall: number;
  latency_ms_total: number;
  /** Pro-Stage-Timings (#38). Optional — alte Hook-Events ohne Stage-
   *  Emitter haben das Feld nicht. */
  recall_stages?: RecallStageBuckets;
  /**
   * #362 Phase 0: Wie lange der Event Loop während dieses Recalls am Stück
   * blockiert war (ms). MiniSearch läuft synchron im Hauptthread — solange es
   * rechnet, kommt weder die Ollama-Antwort noch ein Timer dran.
   */
  event_loop_block_ms?: number;
  /**
   * Woher `event_loop_block_ms` stammt. `"probe"` = ein Timer hat die
   * Verzögerung gemessen. `"sync-fallback"` = der Timer kam nie dran, weil der
   * ganze Recall synchron lief (kein dichter Arm, also kein `await`
   * dazwischen) — dann steht dort die BM25-Zeit, die in diesem Fall exakt die
   * Blockade IST.
   *
   * Ohne diese Unterscheidung sähe der schlimmste Fall — durchgehend blockiert —
   * aus wie der beste: gar kein Feld.
   */
  event_loop_block_source?: "probe" | "sync-fallback";
  /**
   * #362 Phase 2: Welchen Suchmodus der Router GEWÄHLT HÄTTE, plus seine
   * Kostenschätzung. Reiner Schatten — die Suche lief unverändert.
   *
   * Der Wert dieser Spalte liegt darin, dass sie nichts tut: Sie sagt, wie oft
   * ein Modus gegriffen hätte, bevor ihn jemand scharf schaltet.
   */
  shadow_route?: {
    mode: string;
    estimated_lexical_ms: number;
    lexical_fits: boolean;
    unique_terms: number;
  };
  /** Shared learned-recall (#120): bridge expansion applied to this query, if any. */
  bridge_expansion?: BridgeExpansion;
  /** #121: the deeper candidate pool (incl. below-floor ranks) behind this recall. */
  candidate_pool?: { id: string; score: number }[];
  /** #282: opt-in second recall over tool_input_excerpt. The excerpt itself is
   *  intentionally not logged; only the arm's yield and cost are observable. */
  content_recall?: {
    hit_count: number;
    added_count: number;
    rescored_count: number;
    latency_ms: number;
    failed?: boolean;
    /** P0: Der Content-Arm degradierte anders als der Prompt-Arm — seine Hits
     *  lagen in einem anderen Score-Raum und wurden deshalb NICHT gemischt.
     *  Aufgezeichnet, weil ein stillschweigend verworfener Arm sonst wie ein
     *  Arm ohne Ertrag aussieht (`hit_count > 0`, `added_count = 0`). */
    skipped_score_space?: true;
  };
  /**
   * Zweiter Gegenreview: In welchem Raum `top_score` und `hits[].score` liegen
   * — `"rrf"` = fusionierte Rang-Summe, die Bänder 30/50/100 beschreiben
   * etwas; `"bm25"` = roher, nach oben offener MiniSearch-Wert, die Bänder
   * beschreiben nichts. Ohne dieses Feld ist jede Auswertung über `top_score`
   * eine Zahl ohne Skala, und die Floor-Kalibrierung lernte aus rohen
   * Sechsstellern „starke" und aus fusionierten 60ern „schwache" Fälle.
   * Optional: ältere Events haben es nicht — ein fehlender Wert heißt
   * „unbekannt", nicht „rrf".
   */
  score_kind?: "rrf" | "bm25";
  /** Der Raum von `candidate_pool`, SEPARAT geführt: Bei aktiven Commons kommt
   *  der Pool aus der persönlichen Suche und `top_score` aus der Liste nach der
   *  Commons-Runde — die beiden können auseinanderfallen. */
  candidate_pool_score_kind?: "rrf" | "bm25";
  /**
   * Die ARMMENGE und die FORMELVERSION des `candidate_pool` — dieselbe volle
   * Signatur, die `score_arms`/`score_version` für `top_score` tragen.
   *
   * Codex-Gegenreview (P1): Der Pool trug nur seinen `score_kind`. Gemessen:
   * `top_score: 150` aus drei Armen (bm25+commons+vector) gegen einen Pool mit
   * Spitzenwert 80 aus zwei Armen (bm25+vector) — beide meldeten `"rrf"`, also
   * hielt `extractCandidatePools()` sie für denselben Raum und las 150 als
   * Pool-Score. Ein schwacher persönlicher Recall wurde damit nie zum
   * Bridge-Reranking geschickt. `score_kind` allein reicht nicht; nur Kind +
   * Version + Armmenge zusammen bestimmen den Raum.
   *
   * Optional: ältere Events haben die Felder nicht — ein fehlender Wert heißt
   * „unbekannt", nicht „gleich wie top_score".
   */
  candidate_pool_score_arms?: string[];
  /** Version der Pool-FORMEL. Wie beim Haupt-Score NUR auf einer fusionierten
   *  Skala gesetzt — auf rohem BM25 gibt es keine Formel, deren Version man
   *  nennen könnte, und eine dort hingeschriebene Version ließe zwei
   *  unvergleichbare Räume vergleichbar aussehen. */
  candidate_pool_score_version?: string;
  /** Welche ARME den Score gebildet haben, sortiert — siehe `score-space.ts`.
   *  Feiner als `score_kind`, und seit dem Commons-Arm die Dimension, an der
   *  Vergleichbarkeit hängt. */
  score_arms?: string[];
  /** Version der Score-FORMEL. Ohne sie wäre eine spätere Formeländerung
   *  historisch nicht auswertbar: Zwei Zeilen mit derselben Armmenge sähen
   *  vergleichbar aus, obwohl die Zahl dazwischen ihre Bedeutung geändert
   *  hat. Nur auf fusionierten Antworten gesetzt — auf einer rohen Skala gibt
   *  es keine Formel, deren Version man nennen könnte. */
  score_version?: string;
  /** #249: no hit lexically anchored — the hybrid score was rank-1-of-nothing.
   *  Recorded, not just returned: without it a stats run reports zero weak
   *  recalls on every vault, which reads as health and is actually silence. */
  weak_result?: boolean;
  /** #230: stricter than weak_result — the top hit lives in one arm only, the
   *  shape a genuinely absent fact takes. Strict subset, so no_home implies
   *  weak_result. Recorded to make the no-home rate measurable at all. */
  no_home?: boolean;
  /** #165: served BM25-only because the embedding circuit breaker was open. */
  embedding_degraded?: boolean;
  /** #342: which leg dropped out — `vector-arm-timeout` (missed its per-arm
   *  deadline) or `vector-arm-empty` (had nothing to say). See the hook event. */
  degraded_reason?: string;
  /**
   * #494: Der Aufrufer hat den dichten Arm ABGEWÄHLT — kein Embed, kein
   * Timeout, keine Latenzstichprobe. Ausdrücklich verschieden von
   * `degraded_reason` (ein Arm ist ausgefallen) und von seiner Abwesenheit auf
   * einer Maschine ohne Embeddings (es gibt gar keinen Arm). Ohne die
   * Unterscheidung zählte die Auswertung zu #492 Kaltstarts, die nie gemessen
   * wurden. Gesetzt vom kalten SessionStart (`session-lane.ts`).
   */
  lexical_only?: boolean;
  /**
   * #491 — die SCHATTENSPALTE des gelernten Latenzprofils.
   *
   * Was hier steht, hat auf diesen Recall nichts bewirkt: `deadline_ms` ist die
   * Zahl, die tatsächlich galt (150 / 350 / 1500, von Hand getippt),
   * `predicted_deadline_ms` die, die ein aus dieser Maschine gelerntes Profil
   * gesagt hätte. Der Sinn der Spalte ist, dass sie nichts tut — sie sagt vor
   * dem Scharfschalten (#492), ob die gelernte Zahl die feste schlägt oder
   * mindestens hält.
   *
   * Die fünf Torbedingungen aus #492 lesen sich direkt hieraus: Anzahl der
   * Zeilen pro Lane (`dimensions.hook_source`), `residency: "cold"` für die
   * Kaltstarts, `predicted_deadline_ms` gegen `actual_settle_ms` für die
   * Timeout-Quote, `cap_reason` für die Deckelung, `profile_key` für eine
   * zweite Maschine.
   *
   * Fehlt bei einem Recall ohne dichten Arm, bei offenem Breaker und bei einem
   * Cache-Hit — überall dort gab es keinen Arm, über den etwas zu prognostizieren
   * gewesen wäre.
   */
  deadline_shadow?: DeadlineShadowRow;
  /** #217: would-be re-ranking under the salience multiplier (shadow mode). */
  salience_shadow?: SalienceShadow;
  /** #160: same projection for the usage-driven trust multiplier. Present on
   *  the hook path too, which is the busier caller of the two. */
  trust_shadow?: TrustShadow;
}

/** #217 Phase 2: Reflex-Injektion ohne aktive Query (POST /hook/reflex) —
 *  jede Feuerung ist execution-traced: welcher Trigger hart gematcht hat,
 *  wie groß der Reflex-Pool war, was nach dem Budget-Cut serviert wurde. */
export interface HookReflexEvent extends BaseEvent {
  kind: "hook_reflex";
  /** null = kein Hit serviert → bewusst keine recall_id gemintet, damit der
   *  follows_recall-Join (≤5min) nicht von jedem Prompt verwässert wird. */
  recall_id: string | null;
  context_chars: number;
  project: string | null;
  /** Anzahl reflex-markierter Memories im Vault (Match-Grundmenge). */
  reflex_pool: number;
  /** alle harten Matches VOR dem Budget-Cut. */
  matched: { id: string; phrase: string }[];
  /** nach Budget-Cut tatsächlich zurückgegebene ids. */
  served: string[];
  latency_ms: number;
}

// #495: Die Zeilen des Embedding-Pfades stehen seit dem Herausschneiden in
// `telemetry-events-embedding.ts` (Datei lag über der 800-Zeilen-Grenze). Der
// Re-Export hält jeden bestehenden Importpfad gültig.
export type {
  OllamaLifecycleEvent,
  WarmupSettleEvent,
  VectorLateSettleEvent,
} from "./telemetry-events-embedding.js";
