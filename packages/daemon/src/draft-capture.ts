/** Broad local capture (#1084, B1). No vault writes and no language word lists. */
import { afterFailureForTurn, situationForTurn } from "./draft-situation.js";
import { isSystemInjectedTurn, textBeforeDraftBand } from "./system-turn.js";
import { captureDrafts, draftFingerprint, draftId, type Draft, type DraftAfterUpdate } from "./draft-store.js";
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
  vaultId?: string,
): Promise<{ count: number; appended: number; evicted: number; ids: string[]; omitted: number; stored: number }> {
  const drafts: Draft[] = [];
  let stored = 0;
  const shapes = new Map(candidates.map(c => [c.turn, c]));
  // Short typed replies still delimit the command window, even if not drafted.
  const typed = (turn: HarvestTurn): boolean => {
    const text = textBeforeDraftBand(turn.content).trim();
    return turn.role === "user" && text.length > 0 && text.length < PASTE_MIN_CHARS
      && !text.startsWith(INTERRUPT_PREFIX) && !isSystemInjectedTurn(text);
  };
  for (let i = entry.harvested_upto ?? 0; i < turns.length; i++) {
    const turn = turns[i];
    const text = textBeforeDraftBand(turn.content).trim();
    if (!typed(turn) || (text.match(/\p{L}/gu) ?? []).length < DRAFT_MIN_LETTERS) continue;
    if (storedIn && storedIn(text) !== null) { stored++; continue; }
    const shape = shapes.get(i);
    const fp = draftFingerprint(text);
    drafts.push({
      id: draftId(entry.session_id, i, fp), fp,
      ...(vaultId ? { vault_id: vaultId } : {}),
      kind: afterFailureForTurn(turns, i, typed) ? "after-failure" : shape?.kind ?? "typed",
      quote: text, ...(shape?.context ? { context: shape.context } : {}),
      situation: situationForTurn(turns, i, typed),
      evidence: [{ session_id: entry.session_id, turn: i, ts: turn.at ?? now, ...(entry.client ? { client: entry.client } : {}) }],
      created: now, last_touched: now, surfaced: [], state: "open",
    });
  }
  const afterUpdates: DraftAfterUpdate[] = [];
  // The queue cursor already identifies the old/new boundary; no queue change.
  let previous = Math.min(entry.harvested_upto ?? 0, turns.length) - 1;
  while (previous >= 0 && !typed(turns[previous])) previous--;
  if (previous >= 0) {
    const after = situationForTurn(turns, previous, typed).after;
    if (after.length > 0) afterUpdates.push({ session_id: entry.session_id, turn: previous, after });
  }
  const result = await captureDrafts(drafts, now, afterUpdates);
  return { ...result, ids: result.ids.slice(0, DRAFT_TELEMETRY_MAX_IDS),
    omitted: Math.max(0, result.ids.length - DRAFT_TELEMETRY_MAX_IDS), stored };
}
