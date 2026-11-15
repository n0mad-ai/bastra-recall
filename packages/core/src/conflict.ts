/**
 * #205 — conflict marking. When a save contradicts an existing memory
 * (`conflict_with`), the vault must neither silently overwrite the old claim
 * nor grow a silently disagreeing sibling. Instead the existing memory gets a
 * visible, plain-markdown conflict block carrying BOTH claims with provenance
 * and dates — readable in Obsidian, a static viewer, or `cat` alike (same
 * principle as the #140 projections: no viewer becomes the gatekeeper).
 *
 * Resolution is a normal `save_memory` with `overwrite=true`: the rewrite
 * replaces the body wholesale, which removes the block — a deliberate act
 * that the audit log (and with it the #288 journal) records.
 */

export const CONFLICT_START = "<!-- bastra-conflict:start -->";
export const CONFLICT_END = "<!-- bastra-conflict:end -->";

/** True when a body carries a conflict block nobody has resolved yet. */
export function hasUnresolvedConflict(body: string | undefined): boolean {
  return typeof body === "string" && body.includes(CONFLICT_START);
}

export interface ConflictClaim {
  /** The claim itself — the summary of the memory / incoming save. */
  statement: string;
  /** Full body of the incoming save; carried so the rejected content is not lost. */
  detail?: string;
  source?: string;
  date?: string;
}

function quote(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"));
}

/** Render the block. Pure; plain markdown only. */
export function renderConflictBlock(existing: ConflictClaim, incoming: ConflictClaim, markedAt: string): string {
  const L: string[] = [];
  L.push(CONFLICT_START);
  L.push("");
  L.push(`## ⚠️ Unresolved conflict (marked ${markedAt})`);
  L.push("");
  L.push(
    "The vault disagrees with itself here. Two claims, one of them has to win — nothing was overwritten and nothing was silently duplicated."
  );
  L.push("");
  L.push(
    `**This memory's claim**${existing.date ? ` (${existing.date}` : " ("}${existing.source ? `, source: ${existing.source})` : ")"}:`
  );
  L.push("");
  L.push(...quote(existing.statement));
  L.push("");
  L.push(
    `**Incoming claim** — a save that was diverted here instead of being created${incoming.date ? ` (${incoming.date}` : " ("}${incoming.source ? `, source: ${incoming.source})` : ")"}:`
  );
  L.push("");
  L.push(...quote(incoming.statement));
  if (incoming.detail && incoming.detail.trim() !== incoming.statement.trim()) {
    L.push("");
    L.push("**Full incoming content** (kept here so the diverted save is not lost):");
    L.push("");
    L.push(...quote(incoming.detail));
  }
  L.push("");
  L.push(
    "Resolve by deciding which claim stands, then re-save this memory with `overwrite=true` carrying that claim — the rewrite removes this block and the audit log records the resolution."
  );
  L.push(CONFLICT_END);
  return L.join("\n");
}
