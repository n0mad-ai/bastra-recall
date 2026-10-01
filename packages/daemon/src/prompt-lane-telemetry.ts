/**
 * UserPromptSubmit lane — the `prompt_hook_call` telemetry row (split out of
 * prompt-lane.ts, #680).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envOff } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import type { HookAgent, HookClientEvidence } from "./hook-surface.js";
import type { ScopeFilterMode } from "./scope-filter.js";
import type { PrewarmOutcome } from "./embedding-prewarm.js";
import type { DetectedMode } from "./prompt-classify.js";

const HOOK_VERSION = "0.3.0"; // 0.3.0 = daemon-side lane (#343)

// ─── telemetry ──────────────────────────────────────────────────────────────

interface PromptHookTelemetry {
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
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
      // #507: prompt is this lane's own hook_source — it never varies per call.
      dimensions: dimensionsFrom({ client, hook_source: "prompt", session_id: payloadSessionId, agent }),
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}
