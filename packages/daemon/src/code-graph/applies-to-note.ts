/**
 * The `applies_to` block in the Write/Edit lane (#578) — memories that declare
 * the file being edited, and memories on files that depend on it.
 *
 * WHY A DETERMINISTIC BLOCK AND NOT A RECALL HIT. `affects_files` candidates
 * carry no recall score. Merging them into the hit list means inventing one,
 * in a space where it means nothing — exactly what `http-hook-routes.ts:543`
 * refuses to do when two recall arms turn out to live in different score
 * spaces. A separate block needs no number, and that is not a formatting
 * preference: a candidate that never enters the bands can never enter the
 * dedupe, backoff and `required` bookkeeping that runs on them, so C-089's
 * "a code hop never produces `required` on its own" holds STRUCTURALLY here
 * rather than by convention.
 *
 * THIS IS A REVERSIBLE ASSUMPTION BY THE TEAM LEAD, NOT A DECISION BY DANIEL
 * (17.09.2026, taken while he was asleep). It is written down so it can be
 * overturned tomorrow without reconstructing how it came about. The named
 * alternative stays open: carry `file_path` in the `/hook/recall` body and
 * build a real, named retrieval arm there. That is the way to go if a genuine
 * ranking between these candidates is ever needed — it was not chosen now
 * because it changes the body contract, which is the harder thing to take back.
 *
 * THE BANDS ARE NOT GONE, THEY ARE UNUSED HERE. `bandOf` in `applies-to.ts`
 * implements #578 literally: `1-hop` is capped at `optional`, and `direct`
 * reaches `required` only on an independent evidence-gate verdict. On this
 * deterministic path there is no gate verdict, so it is called without one and
 * everything is `optional`. Wiring `direct` + evidence gate through to
 * `required` is the intended next step and is a PRODUCT decision for Daniel,
 * not a code change waiting to be made.
 *
 * The block therefore states the relationship instead of a band: a memory that
 * NAMES this file reads differently from one attached to a file that depends
 * on it, and that distinction is what lets the agent judge without a number.
 *
 * Shaped like the #577 dependents block next to it: statements only, no verb
 * the agent is meant to obey, one emit per file per session, hard character
 * cap, budget checked, never throws (§23).
 */

import {
  appliesToCandidates,
  appliesToIndex,
  bandOf,
  type AppliesToCandidate,
  type AppliesToIndex,
} from "./applies-to.js";
import { codeGraphCache, repoRelative } from "./dependents-block.js";
import { MAX_SHOW, type ReadonlySessionState } from "../session-state.js";
import type { CodeGraphCache } from "./cache.js";

/** Memories listed by name before the rest becomes a count, per relationship. */
const MAX_LISTED = 6;
/** Hard ceiling on the emitted block, in characters (~150 tokens at the
 *  lane's own 4-chars-per-token estimate). A number, because a wide fan-in
 *  is exactly the case the per-item caps above cannot bound on their own. */
const MAX_BLOCK_CHARS = 700;
/** Warm-path budget. The lookup is two Map reads plus one hop; the budget
 *  exists so an unexpectedly slow call is dropped rather than emitted late. */
const BUDGET_MS = 10;
/** Keeps the dedupe key out of both the memory-id and the `code:` namespace. */
const DEDUPE_PREFIX = "applies:";

export interface AppliesToNoteOptions {
  /** The file the tool call is about to write, as the hook reported it. */
  filePath: string;
  /** The lane's project anchor — `payload.cwd`, never a git spawn (#575). */
  repoRoot: string;
  /** The lane's session snapshot; an empty one disables the dedupe. */
  session?: ReadonlySessionState;
  /** Injectable for tests; defaults to the shared caches. */
  index?: AppliesToIndex | null;
  cache?: CodeGraphCache;
}

export interface AppliesToNote {
  note: string;
  /** Key to book under `shown` once the block has actually gone out. */
  dedupeKey: string;
  /** What the block is about, for telemetry and tests. */
  candidates: AppliesToCandidate[];
}

/** The session key for one file's applies_to block. */
export function appliesToDedupeKey(repoRelFile: string): string {
  return `${DEDUPE_PREFIX}${repoRelFile}`;
}

/**
 * The applies_to block for a pending write, or `null`.
 *
 * `null` covers every state that asks for silence: the kill switch, a path
 * outside the anchor, an unbound index, no memory declaring anything about
 * this file, a block already shown this session, and an overrun budget. A cold
 * code graph costs only the one-hop half — the direct half is what the author
 * wrote down and needs no graph at all.
 */
export async function appliesToNote(opts: AppliesToNoteOptions): Promise<AppliesToNote | null> {
  if ((process.env.BASTRA_CODE_AWARENESS ?? "").toLowerCase() === "off") return null;
  const startedAt = Date.now();

  const rel = repoRelative(opts.repoRoot, opts.filePath);
  if (rel === null) return null;

  const index = opts.index !== undefined ? opts.index : appliesToIndex();
  if (index === null) return null;

  const dedupeKey = appliesToDedupeKey(rel);
  if ((opts.session?.shown?.[dedupeKey]?.count ?? 0) >= MAX_SHOW) return null;

  // Cold returns null and schedules the load, so the next edit is warm.
  const graph = (opts.cache ?? codeGraphCache()).get(opts.repoRoot);
  const candidates = appliesToCandidates(index, rel, graph);
  if (candidates.length === 0) return null;

  const note = format(rel, candidates);
  if (note === null || Date.now() - startedAt > BUDGET_MS) return null;
  return { note, dedupeKey, candidates };
}

/**
 * The block. Two groups, because the relationship is the information: a memory
 * that names this file, and a memory attached to a file that depends on it.
 * Every line says which memory and why it is here; none of them says what to
 * do about it.
 */
/**
 * Build the block, SHRINKING it to fit rather than dropping it.
 *
 * This used to return null whenever the finished text passed
 * MAX_BLOCK_CHARS. Measured against the real vault (1243 memories, 259 with
 * `affects_files`): that discarded the block entirely for 134 of the 315
 * files that had matching memories — 43 %, and precisely the files with the
 * MOST attached memories, which are the ones where it is worth most. A cap is
 * a reason to say less, not a reason to say nothing.
 *
 * So the list shrinks until it fits, and the count of what was left out stays
 * visible. Only if even a single entry cannot fit does this give up.
 */
function format(rel: string, candidates: readonly AppliesToCandidate[]): string | null {
  const direct = candidates.filter((c) => c.hop === "direct");
  const hop = candidates.filter((c) => c.hop === "1-hop");

  for (let limit = MAX_LISTED; limit >= 1; limit--) {
    const lines: string[] = [
      `Memories declared for ${rel} via affects_files. Context for this edit, not an instruction.`,
    ];
    if (direct.length > 0) lines.push(`Names this file: ${describe(direct, false, limit)}`);
    if (hop.length > 0) {
      lines.push(
        `Attached to a file that depends on it (one hop, never a duty): ${describe(hop, true, limit)}`,
      );
    }
    // Every line is `optional` by construction on this path — said once,
    // plainly, rather than repeated per entry.
    lines.push(`All of these are ${bandOf(candidates[0]!)} — load one only if it looks relevant.`);

    const note = lines.join("\n");
    if (note.length <= MAX_BLOCK_CHARS) return note;
  }
  return null;
}

function describe(
  candidates: readonly AppliesToCandidate[],
  withVia = false,
  limit: number = MAX_LISTED,
): string {
  const shown = candidates
    .slice(0, limit)
    .map((c) => {
      const name = c.title !== undefined && c.title.length > 0 ? `${c.title} (${c.memoryId})` : c.memoryId;
      const where = c.symbol !== null ? ` #${c.symbol}` : "";
      const via = withVia && c.via !== undefined ? ` via ${c.via}` : "";
      return `${name}${where}${via}`;
    })
    .join("; ");
  const rest = candidates.length - Math.min(limit, candidates.length);
  return rest > 0 ? `${shown}; and ${rest} more` : shown;
}
