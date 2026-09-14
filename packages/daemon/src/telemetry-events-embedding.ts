/**
 * Die Telemetrie-Formen des EMBEDDING-PFADES — Modell-Lifecycle, Warmup-Settle
 * und das späte Settle eines aufgegebenen dichten Arms.
 *
 * Herausgelöst aus `telemetry-events.ts` (#495), weil die Datei über der
 * 800-Zeilen-Grenze lag und dieser Block der einzige darin ist, der gar keinen
 * Recall beschreibt: Er beschreibt, was mit dem MODELL passiert — geladen,
 * entladen, gewärmt, spät fertig geworden. Die drei Zeilen werden zusammen
 * gelesen (die Auswertung von Tor 3 aus #492 joint sie über `run_id` und
 * `session_start_call_id`), also gehören sie zusammen.
 *
 * `telemetry-events.ts` re-exportiert alles, also bleibt jeder Importpfad
 * unverändert.
 */
import type { BaseEvent, DimensionedEvent } from "./telemetry-events.js";

/**
 * Ollama-Modell-Lifecycle (#109): prewarm (Boot-Wakeup) und idle-unload.
 * Aus den Paaren prewarm→unload lässt sich die RAM-Residenz des Embedding-
 * Modells schätzen — die Messgröße hinter dem #78-Energie-Design.
 */
export interface OllamaLifecycleEvent extends Omit<BaseEvent, "session_id"> {
  kind: "ollama_lifecycle";
  /**
   * #363: immer `null` — und das ist die Aussage, nicht ein fehlendes Feld.
   * Beide Emitter laufen ohne jede Claude-Session: der prewarm im Boot-Pfad
   * (index.ts), der unload auf einem 60-s-Timer (daemon-jobs.ts). Vorher
   * stempelte der Sink hier seine Boot-UUID; die sah in `events-*.jsonl` wie
   * eine Session aus und war der Grund, dass "4 Sessions" am 22.08. in
   * Wahrheit 4 Daemon-Starts waren.
   */
  session_id: null;
  /**
   * #363: die Daemon-Boot-id, jetzt unter dem Namen, der sie beschreibt.
   * Nötig, weil das prewarm→unload-Pairing (siehe Doc-Kommentar oben) sonst
   * mit dem session_id-Feld verschwinden würde — die id war echt, nur falsch
   * beschriftet. Identisch mit `Telemetry.runId()` / `AuditEntry.session_id`.
   */
  run_id: string;
  action: "prewarm" | "unload";
  model: string;
  /**
   * `false` = etwas ist GESCHEITERT. Nichts anderes.
   *
   * #495: Bis hierher vermengte das Feld zwei Dinge. Seit #494 läuft das
   * Boot-Prewarm durch den Warmup-Koordinator, und dessen legitime Ausgänge
   * `skipped-warm` (das Modell lag schon im Speicher) und `skipped-in-flight`
   * (ein anderer Auslöser lädt gerade) schrieben `ok: false` — eine Zeile, die
   * wie ein kaputter Boot aussah, obwohl der Singleflight genau das tat,
   * wofür er gebaut wurde. Was WIRKLICH passiert ist, steht jetzt in
   * {@link outcome}; `ok` ist wieder nur die Fehlerfrage.
   */
  ok: boolean;
  /**
   * #495: Der Ausgang, nicht nur „gut/schlecht". Beim `unload` gibt es genau
   * zwei (`fired`/`failed`); beim `prewarm` sind es die Ausgänge des
   * Koordinators, weil er seit #494 der einzige Weg zum Modell ist.
   *
   * Optional, weil Zeilen vor #495 das Feld nicht haben — ein Leser muss
   * „nicht aufgezeichnet" von „gefeuert" trennen können.
   */
  outcome?:
    | "fired"
    | "skipped-warm"
    | "skipped-in-flight"
    | "skipped-no-provider"
    | "skipped-hosted"
    | "failed";
  /** Beim unload: Alter des letzten erfolgreichen Embeds (ms); sonst null. */
  last_embed_age_ms: number | null;
  /** Provider-Calls (query + backfill batches) seit Daemon-Boot. */
  embed_calls_since_boot: number | null;
}

/**
 * #495 — das Settle EINES Warmups, mit seinem Ladevorgang.
 *
 * Die Zeile existiert, weil #494 den kalten SessionStart lexikalisch gemacht
 * hat. Das ist fürs Verhalten richtig, verschiebt den Kaltstart aber aus dem
 * dichten Arm (der ihn seit #493 sauber meldet, siehe
 * {@link VectorLateSettleEvent.provider_load_ms}) in den Warmup — und der
 * meldete gar nichts. Isolierter Realtest 08.09.2026 (zweites Ollama auf
 * 11435, Modell nachweislich nicht resident): direkter kalter Embed
 * 524,709 ms, der SessionStart erzeugte zwei `lexical_only`-Zeilen mit
 * Residenz `unknown` und 520 ms später ein `ollama_lifecycle prewarm ok` —
 * nirgends ein `provider_load_ms`, nirgends ein `cold_start_observed`.
 * Tor 3 aus #492 zählt genau diese Kaltstarts; ohne diese Zeile hoben sich die
 * Optimierung und ihr Messkriterium gegenseitig auf.
 *
 * EIGENE Zeile statt eines Feldes an `ollama_lifecycle`: Die entsteht nur beim
 * Boot und beim Unload, dieser Warmup dagegen bei allen drei Auslösern — und
 * er trägt die Klammer des Sitzungsstarts, der ihn ausgelöst hat.
 */
export interface WarmupSettleEvent extends Omit<BaseEvent, "session_id"> {
  kind: "warmup_settle";
  /** Wie bei `ollama_lifecycle`: Ein Warmup gehört keiner Claude-Session — er
   *  läuft im Boot, auf einem Turn-Start oder neben einem Sitzungsstart. Die
   *  Zuordnung leistet `session_start_call_id`, nicht eine erfundene Session. */
  session_id: null;
  /** Die Daemon-Boot-id (identisch mit `OllamaLifecycleEvent.run_id`). */
  run_id: string;
  /** WER gewärmt hat: `boot` | `turn` | `session`. */
  trigger: "boot" | "turn" | "session";
  model: string | null;
  /** `false` = der Warmup-Embed ist gescheitert. */
  ok: boolean;
  /** Wanduhr des Warmup-Embeds. */
  duration_ms: number;
  /** ROH, wie überall auf diesem Pfad: Ollamas `load_duration`. `null` = der
   *  Provider meldet keine (gehostete API, oder `embed()` ohne Meta). */
  provider_load_ms: number | null;
  /** `provider_load_ms >= PROVIDER_COLD_LOAD_MS` — die Größe, die Tor 3 zählt. */
  cold_start_observed: boolean;
  /** Die Residenz, die VOR dem Warmup galt, also sein Anlass. */
  residency_before: "warm" | "cold" | "unknown" | "hosted";
  /** #493: die Klammer des Sitzungsstarts, neben dem dieser Warmup lief. Nur
   *  der `session`-Auslöser hat sie. */
  session_start_call_id?: string;
  /** #493: für Tor 5 aus #492 — welche Maschine das war. */
  host_profile_id?: string;
}

/**
 * #489 — das ECHTE Settle eines aufgegebenen dichten Arms.
 *
 * `abandonAfter` bricht nicht ab: Der Embed läuft nach dem Aufgeben weiter und
 * wärmt das Modell für den nächsten Aufruf. Bisher wurde sein Ende nirgends
 * notiert — die Stage endete an der Deadline, und eine Verteilung aus solchen
 * Werten lernt genau die Grenze, die schon gilt (`session-context` las p95
 * 312 ms gegen eine 350-ms-Deadline: keine Verteilung, eine Wand).
 *
 * EIGENE Zeile statt eines Feldes am `hook_recall`: Der Wert trifft ein,
 * nachdem der Recall beantwortet und sein Event geschrieben ist. Ein Feld, das
 * nachträglich in ein schon geschriebenes Event mutiert, wäre ein Rennen. Der
 * Join läuft über `recall_id`.
 *
 * `late: true` steht redundant an jeder Zeile, weil das die eine Eigenschaft
 * ist, die ein Leser nie übersehen darf: Diese Latenz hat NIEMAND bezahlt.
 */
export interface VectorLateSettleEvent extends BaseEvent, DimensionedEvent {
  kind: "vector_late_settle";
  /** Der Recall, dessen dichter Arm aufgegeben wurde — Join-Schlüssel zum
   *  `hook_recall`-Event mit derselben `recall_id`. */
  recall_id: string;
  /** Die Frist, an der aufgegeben wurde. */
  deadline_ms: number;
  /** Was der Aufrufer tatsächlich gewartet hat (≈ `deadline_ms`) — mitgeführt,
   *  damit die Zeile ohne Join lesbar ist. */
  wait_ms: number;
  /** Wie lange der Arm wirklich brauchte, ab demselben Nullpunkt wie `wait_ms`. */
  settle_ms: number;
  /** `false` = der Arm scheiterte am Ende doch. Dann ist `settle_ms` die Zeit
   *  bis zum Fehler, kein Latenzwert für eine Deadline-Rechnung. */
  settled: boolean;
  late: true;
  /**
   * #491: die Prognose des gelernten Profils für denselben Arm, mitgeführt
   * statt nur über `recall_id` joinbar. Diese Zeile IST die Wirklichkeit des
   * aufgegebenen Arms — sie muss allein beantworten können, ob die gelernte
   * Frist gehalten hätte. Fehlt, wenn kein Schattenprofil aktiv war.
   */
  predicted_deadline_ms?: number;
  cap_reason?: "profile-empty" | "lane-wall-clock" | "lane-too-short" | "floor" | "max-deadline" | "none";
  residency?: "warm" | "cold" | "unknown" | "hosted";
  /** `true` = auch die gelernte Frist wäre gerissen (`settle_ms` über ihr).
   *  #499: Steht jetzt auch auf `lane-too-short`-Zeilen — eine Prognose von 0
   *  ist „nicht weiter warten", und ein spät settelnder Arm reißt sie
   *  definitionsgemäß. Fehlt nur ohne Schattenprofil. */
  shadow_timeout?: boolean;
  /** #495/#499: Hätte das Profil überhaupt einen dichten Arm gestartet? Seit
   *  #499 konstant `true` — der Arm läuft vor BM25, die Prognose kommt danach.
   *  Siehe `shadow_would_wait`. */
  shadow_would_run?: boolean;
  /** #499: Hätte das Profil an dieser Stelle noch gewartet? `false` bei
   *  `predicted_deadline_ms: 0` (`lane-too-short`) — der Arm läuft, wird aber
   *  nicht mehr abgewartet. */
  shadow_would_wait?: boolean;
  /**
   * #493: das ERGEBNIS des aufgegebenen Arms, nicht nur seine Laufzeit.
   *
   * Kriterium 4 aus #492 rechnet die kontrafaktische Fusionsrate: Hätte eine
   * längere Frist diesen Recall fusioniert? Die Laufzeit allein beantwortet
   * das nicht — ein Arm, der spät mit `empty` oder `error` settelt, hätte
   * auch mit jeder Frist nichts beigetragen.
   */
  provider_outcome?: "hits" | "empty" | "error";
  vector_hit_count?: number;
  cold_start_observed?: boolean;
  provider_load_ms?: number;
  residency_source?: "unload-observed" | "provider-load" | "warm-up" | "last-ok" | "hosted" | "none";
  residency_estimated?: boolean;
  /** #493: Gruppierung mehrerer Recalls EINES Sitzungsstarts — siehe
   *  `HookRecallEvent.session_start_call_id`. */
  session_start_call_id?: string;
  host_profile_id?: string;
}
