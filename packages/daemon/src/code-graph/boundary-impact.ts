/**
 * What a whole task changed, and which dependents it never opened (#572).
 *
 * WHY THIS EXISTS. The Write/Edit lane answers one question per edit: "this
 * change has these dependents". It answers it well, and then it dedupes — the
 * same answer is deliberately not repeated within a session
 * (`impactDedupeKey`). Both properties are right for a lane that fires on
 * every call, and together they mean the SESSION-WIDE answer can never emerge
 * from it: after forty edits nobody has computed the union, and nobody has
 * subtracted the files the task went on to open.
 *
 * `find_affected_files` computes a union like it from git — and #606 measured
 * that agents do not call it: 0 of 44 in v3, zero real calls across a full day
 * of sessions. The answer exists and is never asked for. #606's own conclusion
 * was to stop persuading and deliver through Recall's lanes; this module
 * applies that conclusion one level up, at the task boundary instead of at the
 * single edit.
 *
 * WHY THE HITS ARE BOOKED AT EDIT TIME AND ONLY SUMMED HERE. The tempting
 * design asks the graph once, at Stop. It is wrong, and an adversarial review
 * of the first draft found why: the watcher reindexes after every edit
 * (`service.ts`), so the graph at Stop is the graph AFTER the task. A symbol
 * the task deleted is gone from it together with every edge that pointed at
 * it — exactly the dependents most certain to be broken. The only graph that
 * knows them is the one the Write/Edit lane holds the moment before the edit,
 * and that lane already computes the hits. So it books them
 * (`SessionState.touched`), and the boundary is a pure sum: recorded
 * dependents, minus the files the task wrote.
 *
 * WHY WIDER, NEVER NARROWER. Every fork here resolves the way
 * `pending-diff.ts` resolves it: an extra candidate costs the agent one file
 * it opens and closes, a missing dependent is a mistake it cannot see. So
 * nothing filters on "a body edit cannot break a caller" — a removed side
 * effect, a new throw and a changed invariant all live inside a body.
 *
 * WHY AN UNPLACED EDIT IS NOT SILENCE. The lane cannot always look: cold
 * graph, unreadable change, overrun budget, a fifth apply_patch target. Such a
 * file is asked about here against the CURRENT graph, whole-file. That answer
 * is late and says so (`basis: "whole_file_now"`); with no graph at all the
 * file is returned in `unanswered`. It is never dropped — "I could not look"
 * and "nothing depends on it" must not render the same.
 *
 * THE ONE DELIBERATE NARROWING, NAMED. A dependent the transcript proves was
 * read AFTER the change is moved from `missed` to `seen`, and a boundary with
 * only `seen` files renders nothing. A read is not a review — it may have been
 * partial — so this does trade recall for quiet. It is kept because the
 * per-edit block has already named these files to the agent once; the
 * boundary's new information is "and you never went there", which a later
 * read falsifies. `seen` stays in the result, so the caller can show the count
 * and the trade is reversible in one line.
 */

import { type LoadedGraph } from "./reader.js";
import { type AffectedHit, MAX_AFFECTED_FILES, affectedHits, allSymbolsOf } from "./affected.js";

/** The fields of a hit the accumulator keeps. `AffectedHit` satisfies it. */
export type BookedHit = Pick<AffectedHit, "file" | "location" | "via" | "relation">;

/**
 * One file the task wrote to.
 *
 * `file` is repo-relative with forward slashes — the same spelling the graph
 * uses, produced by the same `repoRelative` for writes and reads alike, so the
 * set arithmetic below compares like with like.
 *
 * `hits` are the dependents booked at edit time; `null` means no edit of this
 * file could be looked at.
 */
export interface BoundaryTouch {
  file: string;
  hits: readonly BookedHit[] | null;
  /** The booked list was capped somewhere on the way. */
  truncated?: boolean;
}

/** Where a missed dependent's evidence comes from. */
export type ImpactBasis = "edit_time" | "whole_file_now";

/** One file the task may have broken and never opened. */
export interface MissedDependent extends BookedHit {
  /** The touched file `via` lives in. */
  changedFile: string;
  basis: ImpactBasis;
}

export interface BoundaryImpact {
  /** The touched files this was computed over, sorted. */
  touchedFiles: string[];
  /**
   * ONE line of evidence per dependent file the task never opened, sorted by
   * path. Empty is the common outcome and the caller renders nothing for it.
   */
  missed: MissedDependent[];
  /** Dependents that were read after the change but not written, sorted. */
  seen: string[];
  /** Unplaced touched files no graph was available to ask about, sorted. */
  unanswered: string[];
  /** True when any list on the way here was capped. */
  truncated: boolean;
}

export interface BoundaryImpactOptions {
  /** Repo-relative files the transcript proves were read after the change. */
  readAfter?: Iterable<string>;
  /** Largest number of missed FILES to return. */
  maxMissed?: number;
}

/**
 * The dependents a task changed but never opened.
 *
 * Pure: no filesystem, no git, no clock. `graph` is only consulted for
 * unplaced touches and may be null.
 */
export function boundaryImpact(
  graph: LoadedGraph | null,
  touches: readonly BoundaryTouch[],
  options: BoundaryImpactOptions = {},
): BoundaryImpact {
  const maxMissed = options.maxMissed ?? MAX_AFFECTED_FILES;
  const readAfter = new Set<string>(options.readAfter ?? []);

  // A dependent living in a written file is not missed even when the task's
  // edit to it was unrelated: the agent had the file in front of it.
  const written = new Set<string>();
  for (const touch of touches) written.add(touch.file);

  // First evidence per file wins. Touches are walked in path order so the same
  // session renders the same block twice — the dedupe downstream keys on it.
  const best = new Map<string, MissedDependent>();
  const unanswered: string[] = [];
  let truncated = false;

  for (const touch of [...touches].sort((a, b) => compare(a.file, b.file))) {
    if (touch.truncated === true) truncated = true;
    let basis: ImpactBasis = "edit_time";
    let hits = touch.hits;
    if (hits === null) {
      if (graph === null) {
        unanswered.push(touch.file);
        continue;
      }
      basis = "whole_file_now";
      hits = affectedHits(graph, touch.file, allSymbolsOf(graph, touch.file), 1);
    }
    for (const hit of hits) {
      if (written.has(hit.file)) continue;
      if (best.has(hit.file)) continue;
      best.set(hit.file, {
        file: hit.file,
        location: hit.location,
        via: hit.via,
        relation: hit.relation,
        changedFile: touch.file,
        basis,
      });
    }
  }

  const all = [...best.values()].sort((a, b) => compare(a.file, b.file));
  const missed = all.filter((m) => !readAfter.has(m.file));
  const seen = all.filter((m) => readAfter.has(m.file)).map((m) => m.file);
  if (missed.length > maxMissed) truncated = true;
  return {
    touchedFiles: [...written].sort(),
    missed: missed.slice(0, maxMissed),
    seen,
    unanswered: [...new Set(unanswered)].sort(),
    truncated,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
