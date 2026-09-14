/** #479 read model for cross-session hint suppression, #484 shadow-aware. */
export interface HintSuppressionSection {
  calls: number;
  hints: number;
  /** Tokens the removals saved — or WOULD have saved, when `modes` shows
   *  shadow calls. Both halves live in the same field on purpose: the same
   *  list produced them, only `modes` says whether it was applied. */
  tokensAvoided: number;
  /** Calls per mode. Events without the field predate #484 and count as live. */
  modes: Array<{ mode: string; calls: number }>;
  unknownTokenCalls: number;
  uniqueMemories: number;
  byType: Array<{ type: string; count: number }>;
  topMemories: Array<{ id: string; type: string; count: number; surfaced: number }>;
}

type Event = Record<string, unknown> & { kind: string };
const numberOrNull = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

export function summarizeHintSuppression(events: Event[]): HintSuppressionSection | null {
  const byType = new Map<string, number>();
  const byId = new Map<string, { type: string; count: number; surfaced: number }>();
  let calls = 0;
  let hints = 0;
  let tokensAvoided = 0;
  let unknownTokenCalls = 0;
  const byMode = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "hook_recall" || !Array.isArray(event.usage_suppressed) || event.usage_suppressed.length === 0) continue;
    calls++;
    hints += event.usage_suppressed.length;
    const mode = typeof event.usage_suppressed_mode === "string" ? event.usage_suppressed_mode : "live";
    byMode.set(mode, (byMode.get(mode) ?? 0) + 1);
    const tokens = numberOrNull(event.usage_suppressed_tokens_est);
    if (tokens === null) unknownTokenCalls++;
    else tokensAvoided += tokens;
    for (const raw of event.usage_suppressed as Array<Record<string, unknown>>) {
      const id = String(raw.id ?? "unknown");
      const type = String(raw.type ?? "unknown");
      byType.set(type, (byType.get(type) ?? 0) + 1);
      const row = byId.get(id) ?? { type, count: 0, surfaced: 0 };
      row.count++;
      row.surfaced = Math.max(row.surfaced, numberOrNull(raw.surfaced) ?? 0);
      byId.set(id, row);
    }
  }
  if (calls === 0) return null;
  return {
    calls,
    hints,
    tokensAvoided,
    modes: [...byMode].map(([mode, count]) => ({ mode, calls: count })).sort((a, b) => b.calls - a.calls),
    unknownTokenCalls,
    uniqueMemories: byId.size,
    byType: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    topMemories: [...byId].map(([id, row]) => ({ id, ...row })).sort((a, b) => b.count - a.count).slice(0, 15),
  };
}
