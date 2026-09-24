/**
 * Hook-surface normalization (#15).
 *
 * Claude Code and Codex now feed the same daemon-side recall lanes. Codex
 * registrations set BASTRA_HOOK_CLIENT=codex; the thin clients copy that
 * value into the payload because the long-running daemon does not inherit a
 * hook process' environment. Codex-specific tool names remain a fallback for
 * hand-written tool-hook registrations.
 *
 * Generic fields such as `model` and `turn_id` are deliberately not surface
 * markers: Claude Code legitimately emits `model` on SessionStart and may
 * widen `turn_id` later. Shared lifecycle events need the registration-owned
 * marker to remain unambiguous.
 */

export type HookClient = "claude-code" | "codex";

export function hookClient(payload: unknown): HookClient {
  if (!payload || typeof payload !== "object") return "claude-code";
  const p = payload as Record<string, unknown>;
  if (p.bastra_client === "codex") return "codex";
  if (p.bastra_client === "claude-code") return "claude-code";
  if (p.tool_name === "apply_patch" || p.tool_name === "update_plan") return "codex";
  return "claude-code";
}

/** #507 Nachbesserung: dieselben drei Belege wie `hookClient()`, aber ohne
 *  dessen claude-code-Default. `hookClient()` darf raten — sie füttert nur das
 *  `surface=`-Attribut im Hint-Block, wo ein plausibler Default besser ist als
 *  gar keine Angabe. Für eine Mess-Dimension ist genau dieser Default ein
 *  geratener Client: ein unmarkierter Aufruf würde still als claude-code
 *  gebucht, obwohl der Payload das nie belegt hat. `"unknown"` ist der
 *  Unbekannt-Wert, den die TelemetryClient-Allowlist (telemetry-dimensions.ts)
 *  bereits kennt. */
export type HookClientEvidence = "claude-code" | "codex" | "unknown";

export function hookClientEvidence(payload: unknown): HookClientEvidence {
  if (!payload || typeof payload !== "object") return "unknown";
  const p = payload as Record<string, unknown>;
  if (p.bastra_client === "codex") return "codex";
  if (p.bastra_client === "claude-code") return "claude-code";
  if (p.tool_name === "apply_patch" || p.tool_name === "update_plan") return "codex";
  return "unknown";
}

/**
 * Who inside the client made the call. Claude Code puts `agent_id` and
 * `agent_type` into a hook payload only when the tool call comes from a
 * subagent (hooks reference, common input fields); a main-thread payload has
 * neither — observed on a live PreToolUse/PostToolUse pair, same session_id.
 * Only the presence of the id is read: `agent_type` can be a user-defined
 * agent name, i.e. free text, and stays out of telemetry (§23).
 *
 * `null` where the payload cannot back an answer — the same rule as
 * `hookClientEvidence` (#507 Nachbesserung): a missing `agent_id` means "main
 * thread" only under Claude Code's contract. A Codex-marked payload never
 * carries the field, so its absence there is no evidence, and booking every
 * Codex call as `main` would be a guessed value in a measurement column.
 * `null` leaves the column off the row (`dimensionsFrom` allowlist).
 */
export type HookAgent = "main" | "subagent";

export function hookAgent(payload: unknown): HookAgent | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as Record<string, unknown>).agent_id;
  if (typeof id === "string" && id.length > 0) return "subagent";
  return hookClientEvidence(payload) === "codex" ? null : "main";
}

/**
 * Who is calling, as a lane tells the daemon in every loopback body
 * (`/hook/recall`, `/hook/act`, `/hook/session-context`). The route copies
 * these fields onto every row it writes for the call (`dimensionHints`), so a
 * field missing here is missing on `hook_recall`, `evidence_decision`,
 * `vector_late_settle` and `hook_act` alike. One constructor, so a lane cannot
 * send `client` and forget `agent`.
 *
 * `client` is the surface default (`hookClient`), not the evidence — the
 * loopback rows have always booked it that way; the lane's own row uses
 * `hookClientEvidence` (#507).
 */
export interface HookCaller {
  session_id: string | null;
  client: HookClient;
  agent: HookAgent | null;
}

export function hookCaller(payload: unknown): HookCaller {
  const sid = payload && typeof payload === "object" ? (payload as Record<string, unknown>).session_id : undefined;
  return {
    session_id: typeof sid === "string" ? sid : null,
    client: hookClient(payload),
    agent: hookAgent(payload),
  };
}

/** Add the registration-owned client marker without mutating stdin data. */
export function decorateHookPayload<T>(payload: T): T {
  const requested = process.env.BASTRA_HOOK_CLIENT;
  if (requested !== "codex" && requested !== "claude-code") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), bastra_client: requested } as T;
}
