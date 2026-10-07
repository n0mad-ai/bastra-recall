/** Broad local capture (#1084, B1). No vault writes and no language word lists. */
import { isSystemInjectedTurn } from "./system-turn.js";
import { captureDrafts, draftFingerprint, draftId, type Draft } from "./draft-store.js";
import type { HarvestCandidate, HarvestTurn } from "./session-harvest.js";

/** Existing harvest paste and interruption boundaries, shared with the relay. */
export const PASTE_MIN_CHARS = 2000;
export const INTERRUPT_PREFIX = "[Request interrupted by user";

/** Unmeasured: use the existing answer threshold until broad capture is measured. */
export const DRAFT_MIN_LETTERS = 20;
/** Bound each telemetry event independently of session length and store size. */
export const DRAFT_TELEMETRY_MAX_IDS = 20;

export async function captureTypedDrafts(
  turns: HarvestTurn[],
  entry: { session_id: string; client?: string; harvested_upto?: number },
  now: number,
  candidates: HarvestCandidate[],
  storedIn?: (quote: string) => string | null,
): Promise<{ count: number; appended: number; evicted: number; ids: string[]; omitted: number; stored: number }> {
  const drafts: Draft[] = [];
  let stored = 0;
  const shapes = new Map(candidates.map(c => [c.turn, c]));
  for (let i = entry.harvested_upto ?? 0; i < turns.length; i++) {
    const turn = turns[i];
    const text = turn.content.trim();
    if (turn.role !== "user" || isSystemInjectedTurn(text)
      || text.length >= PASTE_MIN_CHARS || text.startsWith(INTERRUPT_PREFIX)
      || (text.match(/\p{L}/gu) ?? []).length < DRAFT_MIN_LETTERS) continue;
    if (storedIn && storedIn(text) !== null) { stored++; continue; }
    const shape = shapes.get(i);
    const fp = draftFingerprint(text);
    drafts.push({
      id: draftId(entry.session_id, i, fp), fp, kind: shape?.kind ?? "typed",
      quote: text, ...(shape?.context ? { context: shape.context } : {}),
      situation: { before: [], after: [], reads: [], lits: [] },
      evidence: [{ session_id: entry.session_id, turn: i, ts: now, ...(entry.client ? { client: entry.client } : {}) }],
      created: now, last_touched: now, surfaced: [], state: "open",
    });
  }
  const result = await captureDrafts(drafts, now);
  return { ...result, ids: result.ids.slice(0, DRAFT_TELEMETRY_MAX_IDS),
    omitted: Math.max(0, result.ids.length - DRAFT_TELEMETRY_MAX_IDS), stored };
}
