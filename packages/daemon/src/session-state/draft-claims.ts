/**
 * #1322: the in-process claims on draft hints, so one daemon never hands the
 * same draft to a session twice while the persisted `draftShown` catches up.
 */
import { STATE_MAX_AGE_MS, sessionStateDir } from "./location.js";

// Only this daemon's claims are synchronous. Loaded persistent state and the
// draft store's last five surfaced sessions seed them without hook-path I/O.
const draftClaims = new Map<string, { at: number; ids: Set<string> }>();
/** Non-mutating preflight, before the Bash lane pays for a note lookup. */
export function availableDraftHints(sessionId: string, ids: string[], alreadyShown: string[]): string[] {
  const entry = draftClaims.get(`${sessionStateDir()}:${sessionId}`);
  const stored = new Set(alreadyShown);
  return ids.filter(
    (id) => !stored.has(id) && !(entry && Date.now() - entry.at <= STATE_MAX_AGE_MS && entry.ids.has(id))
  );
}
export function claimDraftHints(sessionId: string, ids: string[], alreadyShown: string[], limit: number): string[] {
  const key = `${sessionStateDir()}:${sessionId}`;
  const now = Date.now();
  for (const [oldKey, entry] of draftClaims) if (now - entry.at > STATE_MAX_AGE_MS) draftClaims.delete(oldKey);
  while (draftClaims.size >= 500 && !draftClaims.has(key)) draftClaims.delete(draftClaims.keys().next().value!);
  const entry = draftClaims.get(key) ?? { at: now, ids: new Set<string>() };
  for (const id of alreadyShown) entry.ids.add(id);
  const selected = ids.filter((id) => !entry.ids.has(id)).slice(0, limit);
  for (const id of selected) entry.ids.add(id);
  entry.at = now;
  draftClaims.set(key, entry);
  return selected;
}
