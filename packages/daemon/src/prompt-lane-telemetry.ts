/**
 * UserPromptSubmit lane — the `prompt_hook_call` telemetry row (split out of
 * prompt-lane.ts, #680).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { envFirst, envOff } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { eventLogFile } from "./telemetry-sink.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import type { HookAgent, HookClientEvidence } from "./hook-surface.js";
import type { ScopeFilterMode } from "./scope-filter.js";
import type { PrewarmOutcome } from "./embedding-prewarm.js";
import type { DetectedMode } from "./prompt-classify.js";

import { projectConfidence } from "./scope-filter.js";
import { repoRootSync } from "./code-graph/git-paths.js";
import { logDeliveredBlock } from "./code-delivered-telemetry.js";
import type { ClaudeHookPayload } from "./prompt-classify.js";
import type { PromptSearch, PromptHintSelection } from "./prompt-lane-search.js";
import type { RecallHit, PromptReflexHit } from "./prompt-format.js";
import type { TakenBoundary } from "./session-state.js";
import type { DeliveredPromptImpact } from "./code-graph/prompt-impact.js";
import { telemetrySession } from "./telemetry-session.js";

const HOOK_VERSION = "0.3.0"; // 0.3.0 = daemon-side lane (#343)

// ─── telemetry ──────────────────────────────────────────────────────────────

export interface PromptHookTelemetry {
  /** #356: the Claude Code session this call belongs to — the payload's
   *  session_id, so per-session aggregation (context tax, #354) is possible.
   *  A synthetic UUID is the fallback only when the payload carried none. */
  session_id?: string | null;
  /** #507: die aufrufende Oberfläche — NUR wenn belegt (`hookClientEvidence`),
   *  nie der surface-Default. */
  client: HookClientEvidence;
  /** Hauptthread oder Subagent (`hookAgent`) — Telemetrie-Dimension `agent`;
   *  `null` ohne Beleg (Codex), dann fehlt die Spalte. */
  agent: HookAgent | null;
  detected_mode: DetectedMode;
  /** #151: true when the trivial-prompt gate suppressed injection. */
  gated?: boolean;
  /** #703: why the prompt was gated when it was not the trivial gate —
   *  "system-injected" (task notification or agent mail). */
  gated_reason?: "system-injected";
  /** #703: "system" when nobody typed this turn (task notification, agent
   *  mail). Absent = an owner prompt. Reach, evidence and prompt counts must
   *  skip "system" rows (#704). */
  origin?: "system";
  prompt_chars: number;
  daemon_url: string | null;
  daemon_reachable: boolean;
  hint_count: number;
  /** #217: Reflex-Hits, die nach Session-Dedup injiziert wurden. */
  reflex_hint_count?: number;
  /** #565: Reflex-Hits, die der Session-Dedup einbehalten hat — der Trigger
   *  hat gematcht, injiziert wurde nichts. Ohne diese Liste sieht ein
   *  unterdrückter Reflex in der Auswertung aus wie ein nie gefeuerter. */
  reflex_deduped_ids?: string[];
  /** #354: tatsächlich injizierte Memory-IDs dieser Lane (Recall + Reflex). */
  hinted_ids?: string[];
  /** #354: Memory-Typ je `hinted_ids`-Eintrag, gleiche Reihenfolge und Länge.
   *  Trennt Direktiven von Fakten in der Context-Tax-Auswertung: eine Regel
   *  der Form „niemals X“ wirkt, indem NICHTS passiert, und kann deshalb per
   *  Konstruktion nie ein `acted_on` erzeugen. Ohne den Typ sieht sie in der
   *  Statistik aus wie eine ungenutzte Faktenmemory. */
  hinted_types?: string[];
  /** #356: est. tokens of what was ACTUALLY injected (recall + reflex
   *  blocks, ~4 chars/token) — the cost side of the context tax (#354).
   *  0 when nothing reached stdout. */
  hint_tokens_est?: number;
  /** #606: Tokens des zugestellten Change-Impact-Blocks, falls einer ausging. */
  code_block_tokens_est?: number;
  /** #606: `basis` des Blocks — symbols | whole_file. */
  code_basis?: string[];
  top_score: number | null;
  latency_ms_total: number;
  /** #161: resolved streak of this event's backoff decision. NOT a
   *  connectivity counter (#352): it is the empty-injection suppression
   *  cadence and climbs on perfectly healthy `status:"ok"` responses. */
  backoff_streak?: number;
  /**
   * §20.5 Shadow-Messung: In welchem Modus der Lane-Scope-Filter lief
   * ("shadow" misst nur) und wie viele Treffer ein Erzwingen verworfen hätte.
   * `dropped_scopes` nennt die fremden Scope-Namen — ohne sie ist eine Zahl
   * nicht auswertbar: „12 verworfen" kann ein einziges Nachbarprojekt sein
   * oder breite Streuung, und das sind zwei verschiedene Entscheidungen.
   */
  scope_filter_mode?: ScopeFilterMode;
  dropped_scope_count?: number;
  dropped_scopes?: string[];
  /** §20.5: "fallback" heißt, der Projektname war geraten — dann filtert die
   *  Lane nicht, und ein `dropped_scope_count` von 0 sagt nichts über Scopes. */
  project_confidence?: "git-root" | "root-match" | "fallback" | "none";
  /** Der Name, gegen den verglichen wurde — null heißt: nicht gefiltert. */
  filter_project?: string | null;
  scope_filter_skipped?: "no-project" | "no-scope-evidence";
  /** #161: true when the empty-streak backoff suppressed the injection. */
  suppressed?: boolean;
  /** #161: est. tokens of the NOT-injected block — the savings side of ROI. */
  suppressed_tokens_est?: number;
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" | "gated" | "suppressed";
  error: string | null;
  /** #361: what the turn-start embedding prewarm did — "fired",
   *  "skipped-debounce" (a turn started inside the keep-alive window),
   *  "skipped-hosted" (a hosted provider has no cold model to warm) or
   *  "skipped-no-provider" (embeddings off, or breaker open). Absent when no
   *  prewarmer was injected. Pairs with the recall event's `degraded:
   *  "vector-arm-timeout"` (#342): the count of those on the FIRST assertion
   *  call of a turn is what the prewarm is supposed to drive to zero. */
  prewarm?: PrewarmOutcome;
  /** #371: why mode "none" did not run a recall on this prompt —
   *  "reflex-pool-empty" (no memory is wired as `recall_mode: reflex`, so the
   *  mode-"none" filter could not have passed anything) or
   *  "reflex-all-suppressed" (every wired memory is inside its 4h session
   *  dedup window, so every hit would have been dropped). Absent means the
   *  recall ran. This is the field that measures the fix: on a skipped prompt
   *  `latency_ms_total` should sit in the pre-19.08. band. */
  recall_skipped?: "reflex-pool-empty" | "reflex-all-suppressed";
  /**
   * P0: Dieser Aufruf lief OHNE Fusion — nur der lexikalische Arm, `score` auf
   * roher Skala, keine Bänder, kein REQUIRED, kein Backoff-Bypass. Absent =
   * regulär fusioniert.
   *
   * Die Lane las den Zustand vorher nicht, also war ein degradierter Aufruf in
   * ihrer eigenen Telemetrie von einem gesunden nicht zu unterscheiden — nur
   * die Recall-Telemetrie wusste davon. Genau diese Lücke macht eine Maschine,
   * die bei JEDEM Aufruf degradiert, unsichtbar.
   */
  unfused?: boolean;
  /** P0/#342: der Grund dafür — `vector-arm-timeout` | `vector-arm-error` |
   *  `vector-arm-empty`. Trennt „zu langsam" von „aus" von „kein Vektor da". */
  degraded?: string;
  /** #702: ids of the learned bridges whose trigger matched this prompt's
   *  query (`/hook/recall` reports them). Absent when none fired. */
  bridges_fired?: string[];
}

export async function writeTelemetry(payload: PromptHookTelemetry): Promise<void> {
  if (envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // The session_id from the Claude payload is real session state — fall
    // back to a synthetic UUID only if no payload session was given (#356).
    const { session_id: payloadSessionId, client, agent, ...rest } = payload;
    const event = {
      kind: "prompt_hook_call",
      ts,
      session_id: telemetrySession(payloadSessionId) ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
      // #507: prompt is this lane's own hook_source — it never varies per call.
      dimensions: dimensionsFrom({ client, hook_source: "prompt", session_id: payloadSessionId, agent }),
    };
    // #702: a replay row goes to its own file (telemetry-sink.ts).
    const file = eventLogFile(logDir, ts, event);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}

/** Only the evidence and observer a telemetry row needs from its turn. */
interface PromptTelemetryTurn {
  payload: Pick<ClaudeHookPayload, "session_id">;
  selfBaseUrl: string;
  startedAt: number;
  clientEvidence: HookClientEvidence;
  agent: HookAgent | null;
  prewarmOutcome: PrewarmOutcome | undefined;
  opts: {
    roundNotice?: string;
    onTelemetry?: (row: PromptHookTelemetry) => void;
  };
}

/** The delivered hint evidence, after fitting and backoff have completed. */
interface PromptTelemetryHints {
  recallHits: RecallHit[];
  reflexKept: PromptReflexHit[];
  suppressed: boolean;
  suppressedTokensEst: number;
  backoffStreak: number;
}

export async function emitTelemetry(turn: PromptTelemetryTurn, row: PromptHookTelemetry): Promise<void> {
  row.hint_tokens_est = (row.hint_tokens_est ?? 0) + Math.ceil((turn.opts.roundNotice?.length ?? 0) / 4);
  await writeTelemetry(row);
  turn.opts.onTelemetry?.(row);
}

/** The telemetry row of a turn that ran no recall. */
export function gatedRow(
  turn: PromptTelemetryTurn,
  promptChars: number,
  extra: Partial<PromptHookTelemetry>
): PromptHookTelemetry {
  return {
    session_id: turn.payload.session_id ?? null,
    client: turn.clientEvidence,
    agent: turn.agent,
    detected_mode: "none",
    gated: true,
    ...extra,
    prompt_chars: promptChars,
    daemon_url: turn.selfBaseUrl,
    daemon_reachable: true,
    hint_count: 0,
    hint_tokens_est: 0,
    top_score: null,
    latency_ms_total: Date.now() - turn.startedAt,
    status: "gated",
    error: null,
    prewarm: turn.prewarmOutcome,
  };
}

/** The `prompt_hook_call` row of a turn that reached the search stage. */
export function recallTurnRow(
  turn: PromptTelemetryTurn,
  prompt: string,
  search: PromptSearch,
  selection: PromptHintSelection,
  emit: PromptTelemetryHints,
  blocks: string[],
  impact: DeliveredPromptImpact
): PromptHookTelemetry {
  const { resp } = search;
  const shown = emit.suppressed ? [] : [...emit.recallHits, ...emit.reflexKept];
  return {
    session_id: turn.payload.session_id ?? null,
    client: turn.clientEvidence,
    agent: turn.agent,
    detected_mode: search.detectedMode,
    prompt_chars: prompt.length,
    daemon_url: turn.selfBaseUrl,
    // A skipped recall (#371) is not an unreachable daemon: the lane IS the
    // daemon and the vault answered the question locally.
    daemon_reachable: resp !== null || search.reflexResp !== null || search.recallSkipped !== undefined,
    hint_count: emit.suppressed ? 0 : emit.recallHits.length,
    reflex_hint_count: emit.reflexKept.length,
    ...(selection.reflexDeduped.length > 0 ? { reflex_deduped_ids: selection.reflexDeduped } : {}),
    // #354: which memories this lane actually injected, and of what type.
    // The prompt lane was the one hint source the context-tax evaluation could
    // not see per memory — it reported only counts. Suppressed emits stay
    // empty: nothing reached the transcript, so nothing was taxed.
    hinted_ids: shown.map((h) => h.id),
    hinted_types: shown.map((h) => h.type),
    hint_tokens_est: blocks.length === 0 ? 0 : Math.ceil(blocks.join("\n").length / 4),
    // #606: the code block's own cost and reach, separate from the memory
    // hints — the ROI question is what the CODE context costs, and
    // `hint_tokens_est` counts the whole injected document.
    ...(impact.block !== null
      ? {
          code_block_tokens_est: impact.tokensEst,
          code_basis: impact.basis === null ? [] : [impact.basis],
        }
      : {}),
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - turn.startedAt,
    backoff_streak: emit.backoffStreak,
    ...scopeFilterFields(selection.scopeFilter, search.cwd),
    ...recallQualityFields(resp),
    suppressed: emit.suppressed,
    suppressed_tokens_est: emit.suppressedTokensEst,
    status: emit.suppressed ? "suppressed" : selection.status,
    error: search.errMsg,
    prewarm: turn.prewarmOutcome,
    recall_skipped: search.recallSkipped,
  };
}

/**
 * §20.5 Shadow-Messung: was ein Scope-Filter hier verwerfen WÜRDE, plus der
 * Kontext, in dem die Entscheidung fällt — Modus (shadow/enforce),
 * Projekt-Scope, Retrieval-Modus (steht schon als detected_mode in der Zeile)
 * und `unfused`. Die Scope-Namen kommen mit, damit sich auswerten lässt, ob
 * dieselben zwei Fremdprojekte alles ausmachen oder ob es breit streut.
 */
function scopeFilterFields(scopeFilter: PromptHintSelection["scopeFilter"], cwd: string) {
  return {
    scope_filter_mode: scopeFilter.mode,
    dropped_scope_count: scopeFilter.droppedCount,
    project_confidence: projectConfidence(cwd),
    filter_project: scopeFilter.filterProject,
    ...(scopeFilter.skipped ? { scope_filter_skipped: scopeFilter.skipped } : {}),
    ...(scopeFilter.droppedScopes.length > 0 ? { dropped_scopes: scopeFilter.droppedScopes } : {}),
  };
}

/** How the recall degraded (#302/#342) and which bridges fired (#702); absent when not. */
function recallQualityFields(resp: PromptSearch["resp"]) {
  return {
    ...(resp?.unfused === true ? { unfused: true } : {}),
    ...(resp?.degraded ? { degraded: resp.degraded } : {}),
    ...(resp?.bridges_fired?.length ? { bridges_fired: resp.bridges_fired } : {}),
  };
}

/**
 * #572/#579: one `code_tool_call` row per task-boundary block that reached the
 * transcript — the same shape and the same call the write lane
 * (`write-lane.ts`) and `prompt-impact.ts` use, so all three deliveries group
 * by `delivered_lane` in one readout instead of joining two event kinds.
 *
 * A block the session-dedupe held back is booked as a dedupe hit, the same
 * "which kind of nothing" the other two lanes tell apart. Fire-and-forget: the
 * row is the measurement, never part of the answer.
 */
export function logBoundaryDelivery(sessionId: string | null, cwd: string, taken: TakenBoundary): void {
  void logDeliveredBlock({
    sessionId,
    lane: "boundary",
    repo: repoRootSync(cwd) ?? cwd,
    dedupeHit: taken.note === null,
    // No `basis`: a boundary block has one per dependent (edit-time or
    // whole-file-now), not one for the answer, and inventing a single value
    // would put a number in that column that describes nothing.
    ...(taken.note !== null ? { files: taken.files, tokensEst: Math.ceil(taken.note.length / 4) } : {}),
  });
}
