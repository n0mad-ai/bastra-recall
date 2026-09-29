/**
 * The telemetry shapes of the HOOK path — hook_act, the #491 deadline-shadow
 * row, hook_recall (the /hook/recall server-side view) and hook_reflex.
 *
 * Split out of `telemetry-events.ts` (#680), the same way as the embedding
 * (#495) and code-awareness (#579) rows: the file was over the 800-line mark
 * and this block is read together. `telemetry-events.ts` re-exports
 * everything, so every import path stays valid.
 */
import type { BaseEvent, BridgeExpansion, DimensionedEvent, RecallStageBuckets, TurnSource } from "./telemetry-events.js";
import type { CallerScopeFilterTelemetry } from "./recall-pipeline.js";
import type { SalienceShadow } from "./salience-shadow.js";
import type { TrustShadow } from "./trust-shadow.js";
import type { ReflexNearMiss } from "./reflex.js";

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
  /**
   * #362: der Query-Router (`routeQueryArms`). Nur gesetzt, wo er den dichten
   * Arm abgewählt hätte (`mode: "shadow"`, `applied: false`) oder abgewählt
   * hat (`mode: "live"`, `applied: true`). `would_save_ms` ist im Schatten die
   * Wartezeit auf den dichten Arm nach BM25 — was ein BM25-only-Lauf gespart
   * hätte. Fehlt auf Zeilen vor #362-Router und bei `BASTRA_QUERY_ROUTER=off`.
   */
  query_route?: {
    arms: "bm25";
    reason: "short" | "identifier";
    unique_terms: number;
    identifier_terms: number;
    mode: "shadow" | "live";
    applied: boolean;
    would_save_ms?: number;
  };
  /** Shared learned-recall (#120): bridge expansion applied to this query, if any. */
  bridge_expansion?: BridgeExpansion;
  /** #421: der Projekt-Scope-Filter der Prompt-Lane, auf dem MCP-Weg in der
   *  gemeinsamen Pipeline angewandt (`recall-pipeline.ts`). Dieselben Namen wie
   *  auf `prompt_hook_call`. Fehlen auf Aufrufen, die ihn nicht anfordern
   *  (Hook-Lanes filtern selbst) — und auf Zeilen vor #421. */
  scope_filter_mode?: CallerScopeFilterTelemetry["scope_filter_mode"];
  dropped_scope_count?: number;
  dropped_scopes?: string[];
  filter_project?: string | null;
  scope_filter_skipped?: CallerScopeFilterTelemetry["scope_filter_skipped"];
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
  /** #565: die Nicht-Feuerungen, die knapp waren — welches Memory, welcher
   *  Trigger kam am nächsten, wie nah, und der Grund. Gedeckelt (3), nur
   *  Trigger-Text, nie ein Memory-Body. Fehlt, wenn es keine gab. */
  near_miss?: ReflexNearMiss[];
  latency_ms: number;
}

// #495: Die Zeilen des Embedding-Pfades stehen seit dem Herausschneiden in
// `telemetry-events-embedding.ts` (Datei lag über der 800-Zeilen-Grenze). Der
