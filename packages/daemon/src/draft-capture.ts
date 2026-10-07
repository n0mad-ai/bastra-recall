/** Broad local capture (#1084, B1). No vault writes and no language word lists. */
import { isSystemInjectedTurn } from "./system-turn.js";
import { captureDraft, draftFingerprint, draftId } from "./draft-store.js";
import type { HarvestCandidate, HarvestTurn } from "./session-harvest.js";

/** Existing harvest paste and interruption boundaries, shared with the relay. */
export const PASTE_MIN_CHARS = 2000;
export const INTERRUPT_PREFIX = "[Request interrupted by user";
export const SAVE_TOOL_RE = /(?:^|__)(?:save_memory|edit_memory|save_hold)$/;

/** Unmeasured: use the existing answer threshold until broad capture is measured. */
export const DRAFT_MIN_LETTERS = 20;

export async function captureTypedDrafts(
  turns: HarvestTurn[],
  entry: { session_id: string; client?: string; harvested_upto?: number },
  now: number,
  candidates: HarvestCandidate[],
  storedIn?: (quote: string) => string | null,
): Promise<{ count: number; ids: string[]; stored: number }> {
  const result = { count: 0, ids: [] as string[], stored: 0 };
  const shapes = new Map(candidates.map(c => [c.turn, c]));
  // Preserve the harvest's conservative "the session already saved it" rule.
  let lastSave = -1;
  for (let i = 0; i < turns.length; i++) {
    if ((turns[i].tools ?? []).some(name => SAVE_TOOL_RE.test(name))) lastSave = i;
  }
  for (let i = entry.harvested_upto ?? 0; i < turns.length; i++) {
    const turn = turns[i];
    const text = turn.content.trim();
    if (turn.role !== "user" || turn.isMeta || isSystemInjectedTurn(text)
      || text.length >= PASTE_MIN_CHARS || text.startsWith(INTERRUPT_PREFIX)
      || (text.match(/\p{L}/gu) ?? []).length < DRAFT_MIN_LETTERS || i < lastSave) continue;
    if (storedIn && storedIn(text) !== null) { result.stored++; continue; }
    const shape = shapes.get(i);
    const fp = draftFingerprint(text);
    const captured = await captureDraft({
      id: draftId(entry.session_id, i, fp), fp, kind: shape?.kind ?? "typed",
      quote: text, ...(shape?.context ? { context: shape.context } : {}),
      situation: { before: [], after: [], reads: [], lits: [] },
      evidence: [{ session_id: entry.session_id, turn: i, ts: now, ...(entry.client ? { client: entry.client } : {}) }],
      created: now, last_touched: now, surfaced: [], state: "open",
    }, now);
    if (captured?.state === "open") {
      result.count++;
      if (!result.ids.includes(captured.id)) result.ids.push(captured.id);
    }
  }
  return result;
}
