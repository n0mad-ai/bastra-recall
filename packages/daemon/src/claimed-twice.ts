/**
 * #360 — the claim gate's counterpart over the existing stock.
 *
 * The gate (`claim-gate.ts`) asks the question at write time, which only helps
 * memories saved from now on. Every pair already in the vault was written
 * before anything asked, so the same check runs once per curator pass and the
 * pairs land in REPORT.md as `claimed twice`. The human decides there; nothing
 * here mutates a memory.
 *
 * Same primitive as the gate and the save-time advisory (`claimingTrigger`,
 * full containment) — three notions of "declares the same situation" inside one
 * codebase would drift apart the moment one of them is tuned.
 *
 * ── Why an inverted index ─────────────────────────────────────────────────
 * The naive sweep is every trigger against every other: a 935-memory vault
 * carries ~5k triggers, so ~25M containment checks per pass, growing
 * quadratically with the vault. But full containment has a property worth
 * exploiting — if EVERY content word of `mine` must appear in `theirs`, then
 * any single word of `mine` is enough to find all possible partners. Picking
 * the rarest one turns the candidate set from "the whole vault" into "the
 * handful of triggers sharing my most distinctive word".
 */
import { GENERATED_TRIGGER_TYPES } from "./claim-gate.js";
import { claimingTrigger } from "./save-quality.js";
import { contentTokens } from "./save-similarity.js";

export interface ClaimedTwicePair {
  /** The memory whose trigger is contained in the other's. */
  fromId: string;
  /** The memory that already declared the situation. */
  toId: string;
  /** `fromId`'s trigger. */
  trigger: string;
  /** `toId`'s trigger — the phrase that makes this a collision. */
  claim: string;
}

interface MemoryLike {
  fm: Record<string, unknown>;
}


interface TriggerEntry {
  id: string;
  trigger: string;
  tokens: Set<string>;
  /** The gate's candidate pool is `scope` + `type` (`save-quality.ts`), so the
   *  sweep uses the same key. Without it the report lists cross-scope pairs the
   *  gate would never have held, and tells the reader they will be held from
   *  now on — which would be false for exactly those rows. */
  pool: string;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/**
 * Pairs in the existing stock that declare one situation and carry no answer.
 *
 * A pair is answered — and therefore absent here — when either side names the
 * other in `replaces`, `superseded_by` or `siblings`. Unresolved `conflict_with`
 * saves never created a second memory at all (#205 diverts them into a block on
 * the first one), so there is no pair left to report.
 *
 * Obsolete memories are skipped: they are out of the living vault's answer set,
 * so they cannot compete for a cue.
 */
/**
 * A finished version chain answers for every pair inside it, not just for
 * neighbours.
 *
 * Measured before this existed: a chain v1 → v2 → v3 with both edges set still
 * reported `v1` against `v3` as an open question. On a real vault that is not a
 * corner case — the largest family here is 13 dated status notes on one
 * workstream, so a fully linked chain would leave roughly ten pairs standing
 * and the work would read as if it had not been done.
 *
 * Reachability is DIRECTED and deliberately so. Two memories are reconciled
 * when one lies on the other's chain — not when they merely touch the same
 * chain. A fork (A and C both superseding B) leaves `A`/`C` open, which is
 * right: two competing successors to one predecessor is a question somebody
 * still has to answer, and quietly calling it settled would hide exactly the
 * kind of split the gate exists to surface.
 *
 * Siblings get no closure. That A stands beside B and B beside C does not make
 * A and C siblings — plausible for a per-person family, an assumption
 * everywhere else, and an assumption is not something to bury in a report that
 * decides what nobody has to look at again.
 */
function closeOverVersionChains(
  olderThan: Map<string, string>,
  answered: Map<string, Set<string>>,
): void {
  const link = (a: string, b: string): void => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const set = answered.get(x) ?? new Set<string>();
      set.add(y);
      answered.set(x, set);
    }
  };
  for (const start of olderThan.keys()) {
    // Walk down this memory's own chain. `seen` guards a cycle written by hand
    // (a → b → a): a malformed edge must not hang the curator pass.
    const seen = new Set<string>([start]);
    let cursor: string | undefined = olderThan.get(start);
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      link(start, cursor);
      cursor = olderThan.get(cursor);
    }
  }
}

export function collectClaimedTwice(
  vault: { list(): MemoryLike[] },
  limit = 50,
): ClaimedTwicePair[] {
  // A vault that predates the gate holds a lot of these — measured on a real
  // 935-memory vault: 62 pairs, found in 23ms. The report shows the first
  // `limit` and SAYS it is bounded (`vault-report.ts`); a list silently cut at
  // 50 reads as "that is all of them", which is the one thing it must not do.
  const entries: TriggerEntry[] = [];
  /** id → the ids it has already been reconciled with, either direction. */
  const answered = new Map<string, Set<string>>();
  /** newer id → the id it supersedes. One edge per memory: a version chain. */
  const olderThan = new Map<string, string>();

  for (const m of vault.list()) {
    const id = typeof m.fm.id === "string" ? m.fm.id : undefined;
    if (!id || m.fm.obsolete === true) continue;
    if (GENERATED_TRIGGER_TYPES.has(String(m.fm.type))) continue;

    // Siblings answer for the pair they name and no further — see
    // `closeOverVersionChains` for why version edges do not stop there.
    const siblings = strings(m.fm.siblings);
    if (siblings.length > 0) {
      const own = answered.get(id) ?? new Set<string>();
      for (const other of siblings) {
        own.add(other);
        // Recorded on one side only (see schema.ts), so read from both.
        const back = answered.get(other) ?? new Set<string>();
        back.add(id);
        answered.set(other, back);
      }
      answered.set(id, own);
    }
    // `replaces` and `superseded_by` are the two halves of one directed edge
    // (#164), normalised here to newer → older.
    if (typeof m.fm.replaces === "string") olderThan.set(id, m.fm.replaces);
    if (typeof m.fm.superseded_by === "string") olderThan.set(m.fm.superseded_by, id);

    const pool = `${String(m.fm.scope ?? "")}\u0000${String(m.fm.type ?? "")}`;
    for (const trigger of strings(m.fm.recall_when)) {
      const tokens = contentTokens(trigger);
      if (tokens.size === 0) continue;
      entries.push({ id, trigger, tokens, pool });
    }
  }

  closeOverVersionChains(olderThan, answered);

  // token → the triggers containing it. Built over every trigger, queried by
  // each trigger's rarest token.
  const byToken = new Map<string, TriggerEntry[]>();
  for (const entry of entries) {
    for (const token of entry.tokens) {
      const bucket = byToken.get(token);
      if (bucket) bucket.push(entry);
      else byToken.set(token, [entry]);
    }
  }

  const pairs: ClaimedTwicePair[] = [];
  const reported = new Set<string>();
  for (const mine of entries) {
    // Full containment means every one of my words is in theirs, so the rarest
    // of them already bounds the candidate set — no partner can be outside it.
    let candidates: TriggerEntry[] | undefined;
    for (const token of mine.tokens) {
      const bucket = byToken.get(token);
      if (bucket && (candidates === undefined || bucket.length < candidates.length)) {
        candidates = bucket;
      }
    }
    if (!candidates) continue;

    for (const theirs of candidates) {
      if (theirs.id === mine.id || theirs.pool !== mine.pool) continue;
      if (answered.get(mine.id)?.has(theirs.id)) continue;
      // One row per memory pair: the same two memories colliding on four
      // triggers is one decision for the human, not four.
      const key = mine.id < theirs.id ? `${mine.id}\0${theirs.id}` : `${theirs.id}\0${mine.id}`;
      if (reported.has(key)) continue;
      if (claimingTrigger(mine.trigger, [theirs.trigger]) === undefined) continue;
      reported.add(key);
      pairs.push({ fromId: mine.id, toId: theirs.id, trigger: mine.trigger, claim: theirs.trigger });
      if (pairs.length >= limit) return pairs;
    }
  }
  return pairs;
}
