import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { readJoinStateSync, writeJoinState } from "./telemetry-join-store.js";
import {
  dimensionsFrom,
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
  HookRecallEvent,
  HookReflexEvent,
  HookActEvent,
  RecallEpisodeEvent,
  EvidenceDecisionEvent,
  MutationIncidentEvent,
  OllamaLifecycleEvent,
  RecallBand,
  TurnSource,
  ReadDocumentEvent,
} from "./telemetry-events.js";

const RECALL_FOLLOWUP_WINDOW_MS = 5 * 60 * 1000;
/**
 * Window during which a load_memory call is treated as a follow-up to a
 * hook_recall hint. A bit longer than the MCP recall→save window because
 * the user has to actually read the hint, decide it's relevant, and ask
 * Claude to load the memory — that round-trip can take a few minutes.
 */
const HOOK_HINT_WINDOW_MS = 10 * 60 * 1000;

interface HookHintTrace {
  recall_id: string;
  rank: number;
  score: number | null;
  ts: number;
}

interface TurnTrace {
  turn_id: string;
  session_id: string;
  started_at: number;
}

interface LoadedMemoryTrace {
  memory_id: string;
  distinctive_tokens: Set<string>;
  turn_id: string;
  turn_source: TurnSource;
  recall_id: string | null;
  surfaced_score: number | null;
  band: RecallBand;
  surfaced: boolean;
  ts: number;
  closed: boolean;
}

// Fenster, in dem ein geladenes Memory für eine acted_on-Episode offen
// bleibt. 180s war zu kurz für die reale Load→Edit-Kadenz: an recall-
// lastigen Tagen fiel KEIN einziger Load in das Fenster (Audit 26.6.). 600s
// = 10 min, konsistent mit HOOK_HINT_WINDOW_MS; env-tunbar.
const ACTED_ON_WINDOW_MS = envInt("BASTRA_ACTED_ON_WINDOW_MS", 600_000);
const SCORE_FLOOR = envInt("BASTRA_RECALL_FLOOR", 30);
const MUST_LOAD_SCORE = envInt("BASTRA_MUST_LOAD_SCORE", 100);

function bandForScore(score: number | null): RecallBand {
  // #469: kein Hint, kein Score, kein Band — nicht „unter dem Floor".
  if (score === null) return "not_hinted";
  if (score >= MUST_LOAD_SCORE) return "required";
  if (score >= SCORE_FLOOR) return "optional";
  return "below_floor";
}

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

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
}

/** Bump bei inkompatibler Snapshot-Shape — alte Snapshots werden dann verworfen. */
const JOIN_STATE_VERSION = 1;
/** Debounce-Fenster für den Disk-Flush des Korrelations-States. */
const JOIN_FLUSH_DEBOUNCE_MS = 1000;

/** Disk-serialisierbare Form des In-Memory-Join-States (Maps/Sets → Arrays). */
interface JoinStateSnapshot {
  version: number;
  lastRecall: { id: string; ts: number } | null;
  hookHints: Array<[string, HookHintTrace]>;
  turns: Array<[string, TurnTrace]>;
  latestTurn: TurnTrace | null;
  adoptedTurnKeys: Array<[string, number]>;
  loadedMemories: Array<
    Omit<LoadedMemoryTrace, "distinctive_tokens"> & { distinctive_tokens: string[] }
  >;
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
  private lastRecall: { id: string; ts: number } | null = null;
  /** Map<memory_id, most-recent HookHintTrace>. Older traces are evicted lazily. */
  private hookHints = new Map<string, HookHintTrace>();
  private turns = new Map<string, TurnTrace>();
  private latestTurn: TurnTrace | null = null;
  private loadedMemories: LoadedMemoryTrace[] = [];
  /** Usage-sidecar sink (#154) — wired by index.ts to recordUsage(vault). */
  private readonly onUsage?: UsageSink;
  private initPromise: Promise<void> | null = null;
  private readonly joinStatePath: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** #206: the daemon-run id, so an audit entry can be correlated with the
   *  telemetry events of the same run. `AuditEntry.session_id` is documented
   *  as exactly this value; it was private and therefore unreachable from the
   *  audit trail. Read-only on purpose — nothing outside may set it. */
  runId(): string {
    return this.sessionId;
  }

  constructor(opts: { onUsage?: UsageSink } = {}) {
    this.onUsage = opts.onUsage;
    this.enabled =
      (envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() !== "off";
    // Log-Pfad bleibt bei `~/.nexus-recall/logs` bis zur User-Data-Migration
    // (Daniel hat existing logs, die wir nicht orphanen wollen).
    this.logDir =
      envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ??
      defaultLogDir();
    this.sessionId = randomUUID();
    // Korrelations-State boot-übergreifend wiederherstellen (Audit 26.6.):
    // ohne das gehen follows_recall/from_hook_recall/recall_episode bei jedem
    // Idle-Respawn verloren. `events-*.jsonl` matcht join-state.json nicht,
    // stats.ts ignoriert es also.
    this.joinStatePath = join(this.logDir, "join-state.json");
    if (this.enabled) this.restoreFromDisk();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  newRecallId(): string {
    const id = randomUUID();
    this.lastRecall = { id, ts: Date.now() };
    this.scheduleFlush();
    return id;
  }

  /** Returns the most recent recall_id if it's still within the follow-up window. */
  recentRecallId(): string | null {
    if (!this.lastRecall) return null;
    if (Date.now() - this.lastRecall.ts > RECALL_FOLLOWUP_WINDOW_MS) return null;
    return this.lastRecall.id;
  }

  /**
   * Record the rank-ordered hits returned by a hook_recall so that a later
   * load_memory(id) can report whether (and where) the id was hinted to the
   * user. Most-recent hint wins on collision.
   */
  /** Forward a usage moment to the sidecar sink — best-effort, never throws. */
  private emitUsage(events: Array<{ id: string; kind: "surfaced" | "loaded" | "acted_on" }>): void {
    if (!this.onUsage || events.length === 0) return;
    try {
      const ts = new Date().toISOString();
      this.onUsage(events.map((e) => ({ ...e, ts })));
    } catch {
      /* usage is telemetry-of-telemetry — never let it break an episode */
    }
  }

  recordHookHints(recall_id: string, hits: Array<{ id: string; score?: number }>): void {
    const ts = Date.now();
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (!hit) continue;
      this.hookHints.set(hit.id, {
        recall_id,
        rank: i + 1,
        score: typeof hit.score === "number" ? hit.score : null,
        ts,
      });
    }
    // Deliberately NO usage emission here: these are the engine's raw top-k.
    // The hook CLIs drop hits client-side (score floors, #110/#148 scope
    // filter, per-session dedup) — counting them as "surfaced" would let
    // phantom demand demote memories nobody ever saw (review find
    // 2026-07-03). The hooks report what they actually injected via
    // POST /hook/hinted → recordSurfacedUsage below.
    this.scheduleFlush();
  }

  /** Usage moment "surfaced" (#154) — fed by POST /hook/hinted with the ids a
   *  hook ACTUALLY injected after its client-side filtering. */
  recordSurfacedUsage(ids: string[]): void {
    this.emitUsage(ids.filter((id) => typeof id === "string" && id.length > 0).map((id) => ({ id, kind: "surfaced" as const })));
  }

  /**
   * Returns the recall_id + rank if this id was hinted in the last
   * HOOK_HINT_WINDOW_MS. Lazy-evicts the entry on miss.
   */
  findHookHintFor(id: string): { recall_id: string; rank: number; score: number | null } | null {
    const t = this.hookHints.get(id);
    if (!t) return null;
    if (Date.now() - t.ts > HOOK_HINT_WINDOW_MS) {
      this.hookHints.delete(id);
      return null;
    }
    return { recall_id: t.recall_id, rank: t.rank, score: t.score };
  }

  rotateTurn(sessionId: string | null): string | null {
    if (!sessionId) return null;
    const trace: TurnTrace = {
      turn_id: randomUUID(),
      session_id: sessionId,
      started_at: Date.now(),
    };
    this.turns.set(sessionId, trace);
    this.latestTurn = trace;
    this.scheduleFlush();
    return trace.turn_id;
  }

  /** Pro Session der zuletzt adoptierte externe Turn-Key (#74). */
  private adoptedTurnKeys = new Map<string, number>();

  /**
   * #74: Adopt an externally stamped turn (forwarder headers — the prompt-hook
   * stamps `turn_id` per user turn into the session feed). Rotates the
   * session's turn only when the key actually changes, so every MCP call in
   * the same user turn shares one turn_id and `turn_source: "session"` —
   * accurate even with multiple CC sessions on one daemon.
   */
  ensureTurn(sessionId: string | null, turnKey: number | null): void {
    if (!sessionId || !turnKey || !Number.isFinite(turnKey)) return;
    if (this.adoptedTurnKeys.get(sessionId) === turnKey) return;
    this.adoptedTurnKeys.set(sessionId, turnKey);
    this.rotateTurn(sessionId);
  }

  private currentTurn(sessionId: string | null): { turn_id: string; turn_source: TurnSource } {
    if (sessionId) {
      const exact = this.turns.get(sessionId);
      if (exact) return { turn_id: exact.turn_id, turn_source: "session" };
    }
    if (this.latestTurn) return { turn_id: this.latestTurn.turn_id, turn_source: "inferred" };
    const fallback = randomUUID();
    this.latestTurn = { turn_id: fallback, session_id: "", started_at: Date.now() };
    return { turn_id: fallback, turn_source: "inferred" };
  }

  /** Live-Notices (#216): optionaler Hook der Map — jede geladene Memory
   *  wird dort als "read"-Ereignis angezeigt. Best-effort, nie werfend. */
  onMemoryLoaded?: (id: string) => void;

  /** Live-Notices "surfaced" (#221): Hook der Map für recall/hook_recall —
   *  die servierten Treffer eines Recalls leuchten auf, nicht nur das seltene
   *  load_memory. Best-effort, nie werfend. Gefiltert und gedeckelt von
   *  `surfacedHits` — das Band entscheidet, nicht der Aufrufer. */
  onRecalled?: (hits: { id: string; band: RecallBand }[]) => void;

  recordLoadedMemory(payload: {
    memory_id: string;
    distinctive_tokens: string[];
    hook_hint: { recall_id: string; score: number | null } | null;
    session_id?: string | null;
  }): void {
    try {
      this.onMemoryLoaded?.(payload.memory_id);
    } catch {
      /* Notices dürfen einen Load nie brechen */
    }
    const tokens = new Set(payload.distinctive_tokens);
    // Usage BEFORE the token gate: the gate only decides whether an acted_on
    // episode is matchable — a load is a load. Without this, terse memories
    // (all words short/stopwords → zero distinctive tokens) never record
    // engagement and the curator would demote actively-loaded memories with
    // no reactivation path (review find 2026-07-03).
    this.emitUsage([{ id: payload.memory_id, kind: "loaded" }]);
    if (tokens.size === 0) return;
    const turn = this.currentTurn(payload.session_id ?? null);
    const now = Date.now();
    this.loadedMemories = this.loadedMemories.filter(
      (entry) => !entry.closed && now - entry.ts <= ACTED_ON_WINDOW_MS,
    );
    this.loadedMemories.push({
      memory_id: payload.memory_id,
      distinctive_tokens: tokens,
      turn_id: turn.turn_id,
      turn_source: turn.turn_source,
      recall_id: payload.hook_hint?.recall_id ?? null,
      surfaced_score: payload.hook_hint?.score ?? null,
      band: bandForScore(payload.hook_hint?.score ?? null),
      surfaced: payload.hook_hint !== null,
      ts: now,
      closed: false,
    });
    this.scheduleFlush();
  }

  matchLoadedMemories(payload: {
    tool_name: string | null;
    tool_input_excerpt: string;
    session_id?: string | null;
    /** #144: when false, a non-matching entry stays OPEN instead of closing
     *  with acted_on=false. The high-frequency Bash act-signal must not let
     *  an unrelated `git status` kill an episode before the real application
     *  arrives; the low-frequency file-edit path keeps the historical
     *  close-on-miss semantics ("the next tool input decides"). */
    closeOnMiss?: boolean;
  }): Omit<RecallEpisodeEvent, "kind" | "ts" | "session_id">[] {
    const closeOnMiss = payload.closeOnMiss !== false;
    const now = Date.now();
    const current = this.currentTurn(payload.session_id ?? null);
    const inputTokens = tokenize(payload.tool_input_excerpt);
    const episodes: Omit<RecallEpisodeEvent, "kind" | "ts" | "session_id">[] = [];

    for (const entry of this.loadedMemories) {
      if (entry.closed) continue;
      if (now - entry.ts > ACTED_ON_WINDOW_MS) {
        entry.closed = true;
        continue;
      }
      if (entry.turn_source === "session" && entry.turn_id !== current.turn_id) continue;

      let matchStrength = 0;
      for (const token of entry.distinctive_tokens) {
        if (inputTokens.has(token)) matchStrength++;
      }
      if (!closeOnMiss && matchStrength < 2) continue; // stays open (#144)
      entry.closed = true;
      episodes.push({
        turn_id: entry.turn_id,
        turn_source: entry.turn_source,
        recall_id: entry.recall_id,
        memory_id: entry.memory_id,
        surfaced_score: entry.surfaced_score,
        band: entry.band,
        surfaced: entry.surfaced,
        acted_on: matchStrength >= 2,
        match_strength: matchStrength,
        tool_name: payload.tool_name,
      });
    }

    this.loadedMemories = this.loadedMemories.filter(
      (entry) => !entry.closed && now - entry.ts <= ACTED_ON_WINDOW_MS,
    );
    this.emitUsage(
      episodes.filter((e) => e.acted_on).map((e) => ({ id: e.memory_id, kind: "acted_on" as const })),
    );
    this.scheduleFlush();
    return episodes;
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
  private dimensionsFor(hints: {
    client?: unknown;
    hook_source?: unknown;
    session_id?: unknown;
  }): TelemetryDimensions {
    return dimensionsFrom(hints, this.experiment);
  }

  /** Die registrierte Experimentkonfiguration setzen. Ohne Aufruf bleibt jedes
   *  Ereignis `unassigned` — die Spalte existiert, behauptet aber nichts. */
  setExperiment(config: ExperimentConfig | null): void {
    this.experiment = config;
  }

  async logRecall(
    payload: Omit<RecallEvent, "kind" | "ts" | "session_id" | "dimensions"> & {
      /** Hinweise auf die Oberfläche — normalisiert, nie durchgereicht. */
      client?: unknown;
      hook_source?: unknown;
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
    const { client, hook_source, session_id, ...rest } = payload;
    await this.write({
      kind: "recall",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...rest,
      dimensions: this.dimensionsFor({ client, hook_source, session_id }),
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
    payload: Omit<HookRecallEvent, "kind" | "ts" | "session_id" | "dimensions"> & {
      session_id?: string;
      client?: unknown;
      hook_source?: unknown;
    },
  ): Promise<void> {
    // "surfaced"-Notice VOR dem enabled-Gate — der Hook-Pfad ist der
    // Löwenanteil des Traffics; die Map-Notice ist UI, nicht Persistenz. Das Band filtert.
    try {
      this.onRecalled?.(surfacedHits(payload.hits));
    } catch {
      /* Notices dürfen einen Hook-Recall nie brechen */
    }
    if (!this.enabled) return;
    const { client, hook_source, ...rest } = payload;
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
    const turn = this.currentTurn(payload.session_id ?? null);
    await this.write({
      kind: "hook_recall",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...rest,
      turn_id: turn.turn_id,
      turn_source: turn.turn_source,
      dimensions: this.dimensionsFor({ client, hook_source, session_id: payload.session_id }),
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
      client?: unknown;
      hook_source?: unknown;
    },
  ): Promise<void> {
    if (!this.enabled) return;
    const { client, hook_source, ...rest } = payload;
    await this.write({
      kind: "evidence_decision",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...rest,
      dimensions: this.dimensionsFor({ client, hook_source, session_id: payload.session_id }),
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
      client?: unknown;
      hook_source?: unknown;
    },
  ): Promise<void> {
    if (!this.enabled) return;
    const { client, hook_source, ...rest } = payload;
    await this.write({
      kind: "hook_act",
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      ...rest,
      dimensions: this.dimensionsFor({ client, hook_source, session_id: payload.session_id }),
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

  // ─── Join-State-Persistenz (Audit 26.6.) ──────────────────────────

  /** Serialisiert den In-Memory-Join-State in eine Disk-taugliche Form. */
  private snapshot(): JoinStateSnapshot {
    return {
      version: JOIN_STATE_VERSION,
      lastRecall: this.lastRecall,
      hookHints: [...this.hookHints.entries()],
      turns: [...this.turns.entries()],
      latestTurn: this.latestTurn,
      adoptedTurnKeys: [...this.adoptedTurnKeys.entries()],
      loadedMemories: this.loadedMemories.map((m) => ({
        ...m,
        distinctive_tokens: [...m.distinctive_tokens],
      })),
    };
  }

  /**
   * Lädt einen persistierten Snapshot beim Boot und filtert jeden Eintrag auf
   * sein Follow-up-Fenster — abgelaufene/geschlossene Spuren werden verworfen,
   * damit ein alter Snapshot keine veralteten Joins wiederbelebt.
   */
  private restoreFromDisk(): void {
    const raw = readJoinStateSync(this.joinStatePath);
    if (!raw || typeof raw !== "object") return;
    const snap = raw as Partial<JoinStateSnapshot>;
    if (snap.version !== JOIN_STATE_VERSION) return;
    const now = Date.now();

    if (snap.lastRecall && now - snap.lastRecall.ts <= RECALL_FOLLOWUP_WINDOW_MS) {
      this.lastRecall = snap.lastRecall;
    }
    if (Array.isArray(snap.hookHints)) {
      for (const [id, trace] of snap.hookHints) {
        if (trace && now - trace.ts <= HOOK_HINT_WINDOW_MS) this.hookHints.set(id, trace);
      }
    }
    if (Array.isArray(snap.loadedMemories)) {
      for (const m of snap.loadedMemories) {
        if (!m || m.closed || now - m.ts > ACTED_ON_WINDOW_MS) continue;
        this.loadedMemories.push({ ...m, distinctive_tokens: new Set(m.distinctive_tokens) });
      }
    }
    // turns/latestTurn/adoptedTurnKeys hängen an den loadedMemories-/hint-
    // Spuren; großzügig auf das längste Follow-up-Fenster filtern.
    const turnTtl = Math.max(HOOK_HINT_WINDOW_MS, ACTED_ON_WINDOW_MS);
    if (Array.isArray(snap.turns)) {
      for (const [sid, t] of snap.turns) {
        if (t && now - t.started_at <= turnTtl) this.turns.set(sid, t);
      }
    }
    if (snap.latestTurn && now - snap.latestTurn.started_at <= turnTtl) {
      this.latestTurn = snap.latestTurn;
    }
    if (Array.isArray(snap.adoptedTurnKeys)) {
      for (const [sid, key] of snap.adoptedTurnKeys) {
        if (this.turns.has(sid)) this.adoptedTurnKeys.set(sid, key);
      }
    }
  }

  /** Debounced Disk-Flush — fasst mehrere Mutationen zu einem Write zusammen. */
  private scheduleFlush(): void {
    if (!this.enabled || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      fireAndForget(writeJoinState(this.joinStatePath, this.snapshot()));
    }, JOIN_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref();
  }

  /** Sofortiger Flush (graceful shutdown + Tests) — umgeht den Debounce. */
  async flushNow(): Promise<void> {
    if (!this.enabled) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await writeJoinState(this.joinStatePath, this.snapshot());
  }

  private async ensureDir(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(this.logDir, { recursive: true }).then(() => undefined);
    }
    await this.initPromise;
  }

  private async write(event: TelemetryEvent): Promise<void> {
    try {
      await this.ensureDir();
      const day = event.ts.slice(0, 10);
      const file = join(this.logDir, `events-${day}.jsonl`);
      await appendFile(file, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      // Telemetry must never break a tool call.
      console.error(`[bastra-recall] telemetry write failed: ${(err as Error).message}`);
    }
  }
}

export function fireAndForget(p: Promise<unknown>): void {
  p.catch((err) => {
    console.error(`[bastra-recall] telemetry: ${(err as Error).message}`);
  });
}

export function logDirFor(): string {
  return envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
}

export { defaultLogDir };

// Re-export so consumers can build paths if needed.
export { dirname };
