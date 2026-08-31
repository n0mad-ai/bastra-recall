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

/** Add the registration-owned client marker without mutating stdin data. */
export function decorateHookPayload<T>(payload: T): T {
  const requested = process.env.BASTRA_HOOK_CLIENT;
  if (requested !== "codex" && requested !== "claude-code") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), bastra_client: requested } as T;
}
