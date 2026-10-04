import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envOff, testRunLogDir } from "./env.js";
import { EventSink } from "./telemetry-sink.js";
import { JoinState, bandForScore } from "./telemetry-join-state.js";
import { callerSessionField } from "./caller-session.js";
import {
  dimensionsFrom,
  recallOrigin,
  splitHints,
  type DimensionHints,
  type ExperimentConfig,
  type TelemetryDimensions,
} from "./telemetry-dimensions.js";

/**
 * Migration-aware default log directory: prefer `~/.bastra/logs`, aber
 * solange das alte `~/.nexus-recall/logs` existiert und das neue noch
 * nicht, lesen wir aus dem alten weiter — damit Daniels existing
 * telemetry beim Migrationsfenster nicht orphan wird. Sobald die Mac-App
 * den `~/.nexus-recall/`-Folder nach `~/.bastra/` verschoben hat (siehe
 * Bastra.AppDelegate Migration), nimmt sich der daemon den neuen Pfad.
 */
function defaultLogDir(): string {
  // #673: a test process never falls through to the developer's real log.
  const underTest = testRunLogDir();
  if (underTest) return underTest;
  const next = join(homedir(), ".bastra", "logs");
  const legacy = join(homedir(), ".nexus-recall", "logs");
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return next;
}

// Event types live in telemetry-events.ts (pure types, split for file size);
// re-exported here so every importer keeps `from "./telemetry.js"`.
export * from "./telemetry-events.js";
import type {
  TelemetryEvent,
  IdScanEvent,
  RecallEvent,
  LoadMemoryEvent,
  SaveMemoryEvent,
  SaveHoldEvent,
  HookRecallEvent,
  HookReflexEvent,
  HookActEvent,
  RecallEpisodeEvent,
  EvidenceDecisionEvent,
  MutationIncidentEvent,
  OllamaLifecycleEvent,
  WarmupSettleEvent,
  VectorLateSettleEvent,
  RecallBand,
  ReadDocumentEvent,
  CodeToolCallEvent,
  CodeGraphRefreshEvent,
} from "./telemetry-events.js";

/** Höchstens so viele Treffer eines Recalls bekommen eine Live-Notice. */
const MAX_SURFACED_NOTICES = 3;

/**
 * Die Treffer eines Recalls, die eine Map-Notice bekommen (#221).
 *
 * Das Band BESCHRIFTET, es filtert NICHT. Was in `hits[]` steht, wurde dem
 * Aufrufer bereits serviert — auf dem recall-Pfad hinter seinem eigenen
 * `min_score` (`parsed.data.min_score ?? RECALL_FLOOR`), auf dem Hook-Pfad
 * ungefiltert. Hier ein zweites Mal gegen den globalen Floor zu schneiden
 * würde die Entscheidung des Aufrufers überstimmen und Notices für Treffer
 * verschlucken, die der Turn tatsächlich gesehen hat: gemessen über zwei Tage
 * lagen 198 von 24 525 recall-Treffern (0,8 %, min 0,39) und 109 von 2 434
 * Hook-Treffern (4,5 %) unter 30 — alle serviert.
 *
 * Gegen Flut hilft nicht der Floor, sondern das Wiederankündigungs-Fenster in
 * live-updates. Das Band reist trotzdem mit, damit die Karte `required` von
 * `optional` unterscheiden kann, ohne selbst Schwellen zu kennen.
 */
function surfacedHits(
  hits: { id: string; score: number }[],
): { id: string; band: RecallBand }[] {
  return hits.slice(0, MAX_SURFACED_NOTICES).map((h) => ({
    id: h.id,
    band: bandForScore(typeof h.score === "number" ? h.score : null),
  }));
}

/**
 * Usage-sidecar sink (#154): receives the memory-usage moments this layer
 * already observes (surfaced/loaded/acted_on), timestamped here so the sink
 * stays a dumb forwarder (index.ts wires it to recordUsage on the vault).
 */
export type UsageSink = (
  events: Array<{ id: string; kind: "surfaced" | "loaded" | "acted_on"; ts: string }>,
) => void;

export class Telemetry {
  private readonly enabled: boolean;
  private readonly logDir: string;
  private readonly sessionId: string;
  /**
   * Die registrierte Experimentkonfiguration (#263, §17.4). `null` heißt: kein
   * Experiment hinterlegt, jedes Ereignis trägt `unassigned`. Die Konfiguration
   * kommt später aus einer versionierten Registrierung, nicht aus dem Code —
   * §17.4 verlangt Mindest-N, Zuweisungsfunktion und Konfiguration gemeinsam
   * abgelegt.
   */
  private experiment: ExperimentConfig | null = null;
  /** Event-log writer (#1039: telemetry-sink.ts). */
  private readonly sink: EventSink;
  /** Correlation state and its persistence (#1039: telemetry-join-state.ts). */
  private readonly joins: JoinState;

  /** #206: the daemon-run id, so an audit entry can be correlated with the
   *  telemetry events of the same run. `AuditEntry.session_id` is documented
   *  as exactly this value; it was private and therefore unreachable from the
   *  audit trail. Read-only on purpose — nothing outside may set it. */
  runId(): string {
    return this.sessionId;
  }

  constructor(opts: { onUsage?: UsageSink; logDir?: string } = {}) {
    this.enabled =
      !envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY");
    // Log-Pfad bleibt bei `~/.nexus-recall/logs` bis zur User-Data-Migration
    // (Daniel hat existing logs, die wir nicht orphanen wollen).
    this.logDir = opts.logDir ?? envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    this.sessionId = randomUUID();
    this.sink = new EventSink(this.logDir);
    // Korrelations-State boot-übergreifend wiederherstellen (Audit 26.6.):
    // ohne das gehen follows_recall/from_hook_recall/recall_episode bei jedem
    // Idle-Respawn verloren. `events-*.jsonl` matcht join-state.json nicht,
    // stats.ts ignoriert es also.
    this.joins = new JoinState({
      enabled: this.enabled,
      sessionId: this.sessionId,
      sink: this.sink,
      joinStatePath: join(this.logDir, "join-state.json"),
      onUsage: opts.onUsage,
    });
    if (this.enabled) this.joins.restoreFromDisk();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  newRecallId(): string {
    return this.joins.newRecallId();
  }

  /** Returns the most recent recall_id if it's still within the follow-up window. */
  recentRecallId(): string | null {
    return this.joins.recentRecallId();
  }

  /**
   * Record the rank-ordered hits returned by a hook_recall so that a later
   * load_memory(id) can report whether (and where) the id was hinted to the
   * user. Most-recent hint wins on collision.
   */
  recordHookHints(recall_id: string, hits: Array<{ id: string; score?: number }>): void {
    this.joins.recordHookHints(recall_id, hits);
  }

  /** Usage moment "surfaced" (#154) — fed by POST /hook/hinted with the ids a
   *  hook ACTUALLY injected after its client-side filtering. */
  recordSurfacedUsage(ids: string[]): void {
    this.joins.recordSurfacedUsage(ids);
  }

  /** #478 Part 2, shadow only: open an act-detection window for INJECTED
   *  hints — see `JoinState.recordSurfacedHints`. */
  recordSurfacedHints(
    hints: Array<{ memory_id: string; distinctive_tokens: string[] }>,
    session_id: string | null,
  ): void {
    this.joins.recordSurfacedHints(hints, session_id);
  }

  /**
   * Returns the recall_id + rank if this id was hinted in the last
   * HOOK_HINT_WINDOW_MS. Lazy-evicts the entry on miss.
   */
  findHookHintFor(id: string): { recall_id: string; rank: number; score: number | null } | null {
    return this.joins.findHookHintFor(id);
  }

  rotateTurn(sessionId: string | null): string | null {
    return this.joins.rotateTurn(sessionId);
  }

  /** #74: adopt an externally stamped turn — see `JoinState.ensureTurn`. */
  ensureTurn(sessionId: string | null, turnKey: number | null): void {
    this.joins.ensureTurn(sessionId, turnKey);
  }

  /** Live-Notices (#216): optionaler Hook der Map — jede geladene Memory
   *  wird dort als "read"-Ereignis angezeigt. Best-effort, nie werfend. */
  onMemoryLoaded?: (id: string) => void;

  /** Live-Notices "surfaced" (#221): Hook der Map für recall/hook_recall —
   *  die servierten Treffer eines Recalls leuchten auf, nicht nur das seltene
   *  load_memory. Best-effort, nie werfend. Gefiltert und gedeckelt von
   *  `surfacedHits` — das Band entscheidet, nicht der Aufrufer. */
  onRecalled?: (hits: { id: string; band: RecallBand }[]) => void;

  recordLoadedMemory(payload: Parameters<JoinState["recordLoadedMemory"]>[0]): void {
    try {
      this.onMemoryLoaded?.(payload.memory_id);
    } catch {
      /* Notices dürfen einen Load nie brechen */
    }
    this.joins.recordLoadedMemory(payload);
  }

  /** Close the open acted_on windows against a tool input — see
   *  `JoinState.matchLoadedMemories`. */
  matchLoadedMemories(
    payload: Parameters<JoinState["matchLoadedMemories"]>[0],
  ): Omit<RecallEpisodeEvent, "kind" | "ts" | "session_id">[] {
    return this.joins.matchLoadedMemories(payload);
  }

  async logRecallEpisode(
    payload: Omit<RecallEpisodeEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "recall_episode",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  /**
   * Die vier Auswertungsspalten, an EINER Stelle gefüllt (#263).
   *
   * Absichtlich hier und nicht bei den Produzenten: `client` und `hook_source`
   * kommen aus einem Request-Body, und drei Produzenten, die drei eigene
   * Normalisierungen schreiben, sind drei Gelegenheiten, eine Allowlist zu
   * vergessen. Was ein Aufrufer mitschickt, ist ein HINWEIS; die Spalte
   * entsteht hier.
   */
  private dimensionsFor(hints: DimensionHints & { session_id?: unknown }): TelemetryDimensions {
    return dimensionsFrom(hints, this.experiment);
  }

  /** Die registrierte Experimentkonfiguration setzen. Ohne Aufruf bleibt jedes
   *  Ereignis `unassigned` — die Spalte existiert, behauptet aber nichts. */
  setExperiment(config: ExperimentConfig | null): void {
    this.experiment = config;
  }

  async logRecall(
    payload: Omit<RecallEvent, "kind" | "ts" | "session_id" | "dimensions" | "origin"> & DimensionHints & {
      /** Die Session des AUFRUFERS, nicht die Boot-id: Aus ihr entsteht das
       *  Pseudonym und daraus der Arm. Fehlt sie, gibt es keinen Arm. */
      session_id?: string | null;
    },
  ): Promise<void> {
    // "surfaced"-Notice VOR dem enabled-Gate — die Map-Notice ist ein UI-Signal,
    // unabhängig von der Telemetrie-Persistenz (wie onMemoryLoaded). Das Band filtert.
    try {
      this.onRecalled?.(surfacedHits(payload.hits));
    } catch {
      /* Notices dürfen einen Recall nie brechen */
    }
    if (!this.enabled) return;
    const { hints, rest: { session_id, ...rest } } = splitHints(payload);
    const dimensions = this.dimensionsFor({ ...hints, session_id });
    await this.write({
      kind: "recall",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      // #708: the caller's Claude Code session, when a forwarded call brought one.
      ...callerSessionField(),
      ...rest,
      // #704: who wrote the query — bridges learn from owner and agent rows only.
      origin: recallOrigin("recall", dimensions.hook_source, rest.query),
      dimensions,
    });
  }

  async logLoadMemory(
    payload: Omit<LoadMemoryEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "load_memory",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  /** #457: eine Zeile pro `read_document`, nur Größen, kein Text. */
  async logReadDocument(
    payload: Omit<ReadDocumentEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "read_document",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logSaveMemory(
    payload: Omit<SaveMemoryEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "save_memory",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...callerSessionField(),
      ...payload,
    });
  }

  /**
   * #477 — ein Save, der nie ein Write wurde. Best-effort wie jedes andere
   * Telemetrie-Ereignis: der Hold selbst passiert auch dann, wenn das
   * Schreiben des Events scheitert.
   */
  async logSaveHold(
    payload: Omit<SaveHoldEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "save_hold",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...callerSessionField(),
      ...payload,
    });
  }

  /** Siehe {@link IdScanEvent} — der Preis der ID-Transaktion, dauerhaft
   *  gemessen statt einmal geschätzt. */
  async logIdScan(
    payload: Omit<IdScanEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "id_scan",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logHookRecall(
    // #363: session_id optional wie bei logHookReflex/logHookAct. Der Hook
    // liefert die echte Claude-Session-id mit (prompt-lane sendet sie im
    // /hook/recall-Body, die Route reicht sie durch) — sie überschreibt via
    // Spread die Daemon-Boot-UUID. Ohne diesen Hatch stempelte jeder der 194
    // hook_recall-Events eines Tages dieselben 4 Boot-ids: keine Auswertung
    // auf Recall-Ebene konnte nach Session oder Turn gruppieren (#305, #361).
    payload: Omit<HookRecallEvent, "kind" | "ts" | "session_id" | "dimensions" | "origin"> & {
      session_id?: string;
    } & DimensionHints,
  ): Promise<void> {
    // "surfaced"-Notice VOR dem enabled-Gate — der Hook-Pfad ist der
    // Löwenanteil des Traffics; die Map-Notice ist UI, nicht Persistenz. Das Band filtert.
    try {
      this.onRecalled?.(surfacedHits(payload.hits));
    } catch {
      /* Notices dürfen einen Hook-Recall nie brechen */
    }
    if (!this.enabled) return;
    const { hints, rest } = splitHints(payload);
    // #305/#361: der Turn, in dem dieser Recall lief. `session_id` allein
    // beantwortet keine Frage auf Turn-Ebene — „wie oft reißt der erste Recall
    // eines Turns seine Deadline" braucht die Turn-Grenze, und die kennt nur
    // diese Klasse (`rotateTurn` bei UserPromptSubmit). Ohne das Feld musste
    // jede solche Auswertung die Grenze aus Zeitstempeln raten.
    //
    // `currentTurn` liefert auch dann etwas, wenn kein Turn bekannt ist —
    // `turn_source` sagt, ob die Zuordnung aus der Session stammt oder
    // erschlossen ist. Beides mitzuschreiben ist der Unterschied zwischen einer
    // Gruppierung, der man trauen kann, und einer, die stillschweigend rät.
    const turn = this.joins.currentTurn(payload.session_id ?? null);
    const dimensions = this.dimensionsFor({ ...hints, session_id: payload.session_id });
    const origin = recallOrigin("hook_recall", dimensions.hook_source, rest.query);
    await this.write({
      kind: "hook_recall",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...rest,
      // #704: who wrote the query. Absent when the caller named no lane.
      ...(origin ? { origin } : {}),
      turn_id: turn.turn_id,
      turn_source: turn.turn_source,
      dimensions,
    });
  }

  /**
   * Der Evidenzentscheid eines Aufrufs (#264) — im Schatten.
   *
   * Eigene Methode und eigene Ereignisklasse, nicht ein Feld am
   * `hook_recall`-Event: Der Entscheid hat einen anderen Lebenszyklus (er wird
   * scharf geschaltet, während der Recall bleibt) und eine andere
   * Vertragsklasse (§10.3 gegen §8.5). Zwei Dinge, die man nie addieren darf,
   * gehören nicht in dasselbe Objekt.
   */
  async logEvidenceDecision(
    payload: Omit<EvidenceDecisionEvent, "kind" | "ts" | "session_id" | "dimensions"> & {
      session_id?: string;
    } & DimensionHints,
  ): Promise<void> {
    if (!this.enabled) return;
    const { hints, rest } = splitHints(payload);
    await this.write({
      kind: "evidence_decision",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...rest,
      dimensions: this.dimensionsFor({ ...hints, session_id: payload.session_id }),
    });
  }

  async logHookReflex(
    // session_id optional wie bei logHookAct: der Hook liefert die echte
    // Claude-Session-id mit — sie überschreibt die Daemon-Boot-UUID, sonst
    // ist ein per-Session-Join gegen Transcripts strukturell unmöglich.
    payload: Omit<HookReflexEvent, "kind" | "ts" | "session_id"> & { session_id?: string },
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "hook_reflex",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logHookAct(
    // session_id optional: der Hook liefert die CLAUDE-Session-id mit — sie
    // überschreibt (via Spread) die Daemon-Boot-UUID, sonst ist ein
    // per-Session-Join gegen Transcripts strukturell unmöglich (Audit 2026-07-10).
    payload: Omit<HookActEvent, "kind" | "ts" | "session_id" | "dimensions"> & {
      session_id?: string;
    } & DimensionHints,
  ): Promise<void> {
    if (!this.enabled) return;
    const { hints, rest } = splitHints(payload);
    await this.write({
      kind: "hook_act",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...rest,
      dimensions: this.dimensionsFor({ ...hints, session_id: payload.session_id }),
    });
  }

  /**
   * Ein Mutations-Incident (#377). Kommt über `onMutationIncident` aus core —
   * core kennt den Daemon nicht, dieselbe Bauform wie `logIdScan`.
   *
   * Trägt die Boot-id als `session_id`: Eine Mutation kann aus jedem Pfad
   * kommen (MCP, REST, Bridge, CLI), und eine Claude-Session gibt es dabei nur
   * manchmal. Die Boot-id sagt wenigstens, WELCHER Daemon-Lauf es war — anders
   * als bei `ollama_lifecycle` ist das hier keine Behauptung über eine Session,
   * weil der Incident selbst über `operation_id` gruppiert wird.
   */
  async logMutationIncident(
    payload: Omit<MutationIncidentEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "mutation_incident",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  /**
   * #579: one row per `find_code` / `find_affected_files` call.
   *
   * The two tools wrote nothing until now, so "nobody calls code awareness" and
   * "code awareness answers nothing" were the same empty log. Shapes only —
   * `code-graph/tool-telemetry.ts` builds the payload and decides what is safe
   * to carry.
   */
  async logCodeToolCall(
    payload: Omit<CodeToolCallEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "code_tool_call",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  /** #579: one row per graph refresh run — `started` plus its terminal outcome. */
  async logCodeGraphRefresh(
    payload: Omit<CodeGraphRefreshEvent, "kind" | "ts" | "session_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "code_graph_refresh",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...payload,
    });
  }

  async logOllamaLifecycle(
    payload: Omit<OllamaLifecycleEvent, "kind" | "ts" | "session_id" | "run_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "ollama_lifecycle",
      ts: new Date().toISOString(),
      // #363: hier gibt es keine Session — der prewarm läuft im Boot-Pfad, der
      // unload auf einem Timer. `null` sagt das; die Boot-UUID behauptete
      // stattdessen eine Session, die nie existierte. Die Boot-id bleibt
      // erhalten, aber als run_id: nur so bleibt das prewarm→unload-Pairing
      // über Daemon-Starts hinweg auswertbar (#109).
      session_id: null,
      run_id: this.sessionId,
      ...payload,
    });
  }

  /**
   * #495 — das Settle eines Warmups, mit seinem Ladevorgang.
   *
   * Wie `logOllamaLifecycle` ohne Session: Ein Warmup gehört keiner
   * Claude-Session. Die Zuordnung zum Sitzungsstart, der ihn ausgelöst hat,
   * leistet `session_start_call_id` im Payload — nicht die Boot-UUID, die hier
   * eine Session behaupten würde, die es nicht gibt (#363).
   */
  async logWarmupSettle(
    payload: Omit<WarmupSettleEvent, "kind" | "ts" | "session_id" | "run_id">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.write({
      kind: "warmup_settle",
      ts: new Date().toISOString(),
      session_id: null,
      run_id: this.sessionId,
      ...payload,
    });
  }

  /**
   * #489 — die späte Stichprobe eines aufgegebenen dichten Arms.
   *
   * Kommt aus einer Fortsetzung, die feuert, NACHDEM der Recall beantwortet
   * ist; deshalb eine eigene Zeile statt eines Feldes am `hook_recall`, das
   * dann schon geschrieben wäre. `recall_id` verbindet beide.
   *
   * Die Session kommt vom Aufrufer mit — der Hook liefert die echte
   * Claude-Session-id im Body, und ohne sie stempelt der Sink die Boot-UUID,
   * unter der sich keine Lane mehr trennen lässt (dieselbe Regel wie bei
   * `logHookRecall`).
   */
  async logVectorLateSettle(
    payload: Omit<VectorLateSettleEvent, "kind" | "ts" | "session_id" | "late"> & {
      session_id?: string;
    } & DimensionHints,
  ): Promise<void> {
    if (!this.enabled) return;
    const { hints, rest: { session_id, ...rest } } = splitHints(payload);
    await this.write({
      kind: "vector_late_settle",
      ts: new Date().toISOString(),
      session_id: session_id ?? this.sessionId,
      late: true,
      ...rest,
      dimensions: this.dimensionsFor({ ...hints, session_id }),
    });
  }

  /** Sofortiger Flush (graceful shutdown + Tests) — umgeht den Debounce. */
  async flushNow(): Promise<void> {
    await this.joins.flushNow();
  }

  private write(event: TelemetryEvent): Promise<void> {
    return this.sink.write(event);
  }
}

export { fireAndForget } from "./telemetry-sink.js";

export function logDirFor(): string {
  return envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
}

export { defaultLogDir };

// Re-export so consumers can build paths if needed.
export { dirname };
