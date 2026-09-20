/**
 * What a whole task changed, and which dependents it never opened (#572).
 *
 * WHY THIS EXISTS. The Write/Edit lane answers one question per edit: "this
 * file has these dependents". It answers it well, and then it dedupes — the
 * same file is deliberately not repeated within a session (`impactDedupeKey`).
 * Both properties are right for a lane that fires on every call, and together
 * they mean the SESSION-WIDE answer can never emerge from it: after forty
 * edits nobody has computed the union, and the one repeat that would have
 * carried it was suppressed on purpose.
 *
 * `find_affected_files` computes exactly this union from git — and #606
 * measured that agents do not call it: 0 of 44 in v3, zero real calls across a
 * full day of sessions. The answer exists and is never asked for. #606's own
 * conclusion was to stop persuading and deliver through Recall's lanes; this
 * module applies that conclusion one level up, at the task boundary instead of
 * at the single edit.
 *
 * WHY THE BOUNDARY IS THE RIGHT MOMENT. The Stop lane already runs there,
 * already holds a graph handle (it enqueues the refresh so the next turn
 * starts current), and already has a silent channel to deliver on
 * (`pending-suggestions.json`, read by the next SessionStart as
 * additionalContext, #48). Because the refresh is enqueued for the NEXT turn,
 * the graph still describes the code as it was BEFORE this task — which is the
 * correct oracle for "who was depending on this when I started".
 *
 * WHY WIDER, NEVER NARROWER. Every fork here resolves the way `pending-diff.ts`
 * resolves it: an extra candidate costs the agent one file it opens and
 * closes, a missing dependent is a mistake it cannot see. So a body-only edit
 * is NOT filtered out even though it usually cannot break a caller — "usually"
 * is not a property this module is allowed to assume. A removed side effect, a
 * new throw and a changed invariant all live inside a body and all break
 * callers that the graph still says depend on it.
 *
 * WHY AN EMPTY DIFF SELECTION MEANS WHOLE FILE, NOT SILENCE. `changedLines`
 * reports `{ lines: [], mappable: true }` for a diff with no hunks — a pure
 * rename being the known case (#603) — and a confident-narrow answer there is
 * a lie: the file's importers all carry a stale specifier. A touched file that
 * yields no changed symbol is therefore reported on its whole-file basis, not
 * dropped. Being told about a file that turned out fine is cheap; being told
 * nothing about a file whose every importer just broke is the failure this
 * module exists to prevent.
 *
 * WHY `affectedHits` AND NOT A WALK OF ITS OWN. The per-edit block is built
 * from `affectedHits`, which knows two things a plain dependent walk does not:
 * the importers of a workspace package by its bare specifier, and the barrels
 * that re-export a file. A boundary answer computed any other way would be
 * NARROWER than the per-edit answers it sums up — the one direction this lane
 * may not err in. One source, so the two cannot drift apart.
 */

import { type CodeSymbol, type LoadedGraph } from "./reader.js";
import {
  type AffectedHit,
  MAX_AFFECTED_FILES,
  affectedHits,
  allSymbolsOf,
  diffSymbols,
} from "./affected.js";

/**
 * One file the task wrote to.
 *
 * `file` is repo-relative with forward slashes — the same spelling the graph
 * uses. Normalising is the caller's job (`repoRelative` in
 * `dependents-block.ts`) so this module stays a pure function over the graph.
 *
 * What changed inside it arrives in one of two forms, and neither is required:
 *
 *   `symbols` — bare names the Write/Edit lane selected at edit time and the
 *     session accumulated. NAMES, not ids: a graph rebuilt mid-session hands
 *     out new ids, and a name is what survives that.
 *   `diff`    — a unified diff for the file.
 *
 * Both absent is not a degraded case that gets skipped: it resolves to the
 * whole-file basis, the honest reading of "this file changed and I cannot say
 * where". So does a recorded name the graph no longer has in this file — the
 * record is then older than the graph, and guessing which of today's symbols
 * it meant would be the confident-narrow answer again.
 */
export interface BoundaryTouch {
  file: string;
  diff?: string | null;
  symbols?: readonly string[] | null;
}

/** How a touched file's changed symbols were determined. */
export type ImpactBasis = "symbol" | "whole_file";

/** One file the task may have broken and never opened. */
export interface MissedDependent extends AffectedHit {
  /** The touched file `via` lives in. */
  changedFile: string;
  /** Whether `via` came from a selection or from the whole-file fallback. */
  basis: ImpactBasis;
}

export interface BoundaryImpact {
  /** The touched files this was computed over, sorted. */
  touchedFiles: string[];
  /** Bare names of the symbols the task changed, sorted and distinct. */
  changedSymbols: string[];
  /**
   * ONE line of evidence per dependent file the task never opened — the same
   * file-counted shape `affectedResult` settled on, for the same reason: the
   * question is "which files". Empty is the common outcome and the caller must
   * render nothing for it.
   */
  missed: MissedDependent[];
  /** True when `missed` was capped and more files exist. */
  truncated: boolean;
}

export interface BoundaryImpactOptions {
  /**
   * Files the task opened WITHOUT writing to them — reads the caller could
   * prove. A dependent in one of them is not missed: the agent looked, and
   * what it concluded there is not this module's to second-guess. Leaving
   * this empty only ever makes the answer wider.
   */
  opened?: Iterable<string>;
  /**
   * Largest number of missed FILES to return. Defaults to the cap the
   * per-edit answer uses, so the boundary block cannot be the one that blows
   * the context budget the lane was careful about.
   */
  maxMissed?: number;
}

/**
 * The dependents a task changed but never opened.
 *
 * Pure: no filesystem, no git, no clock. Everything it needs is the loaded
 * graph and the list of touched files, which makes the whole contract
 * assertable from a fixture.
 */
export function boundaryImpact(
  graph: LoadedGraph,
  touches: readonly BoundaryTouch[],
  options: BoundaryImpactOptions = {},
): BoundaryImpact {
  const maxMissed = options.maxMissed ?? MAX_AFFECTED_FILES;

  // A file is "opened" if the task wrote to it at all, or provably read it. A
  // dependent living in a written file is not missed even when this task's
  // edit to it was unrelated: the agent had the file in front of it.
  const opened = new Set<string>(options.opened ?? []);
  const touched = new Set<string>();
  for (const touch of touches) {
    touched.add(touch.file);
    opened.add(touch.file);
  }

  const changedNames = new Set<string>();
  // First hit per file wins, and `affectedHits` sorts a call site before a
  // package-level import — so the kept line is the most informative one.
  const best = new Map<string, MissedDependent>();

  for (const touch of mergedTouches(touches)) {
    const { symbols, basis } = changedSymbolsFor(graph, touch);
    for (const symbol of symbols) {
      if (symbol.kind !== "file") changedNames.add(symbol.name);
    }
    for (const hit of affectedHits(graph, touch.file, symbols, 1)) {
      if (opened.has(hit.file)) continue;
      if (best.has(hit.file)) continue;
      best.set(hit.file, { ...hit, changedFile: touch.file, basis });
    }
  }

  const all = [...best.values()].sort((a, b) => compare(a.file, b.file));
  return {
    touchedFiles: [...touched].sort(),
    changedSymbols: [...changedNames].sort(),
    missed: all.slice(0, maxMissed),
    truncated: all.length > maxMissed,
  };
}

/**
 * The symbols one touched file changed, and on what basis.
 *
 * The whole-file fallback fires in cases that are all the same case: the
 * caller knew neither names nor diff, a recorded name is gone from the graph,
 * `diffSymbols` could not narrow, or it narrowed to nothing. The last is the
 * rename shape from #603 — no hunks, so no changed line, so no symbol — and
 * treating it as "nothing changed" would hide a file whose every importer now
 * points at a name that is gone.
 */
function changedSymbolsFor(
  graph: LoadedGraph,
  touch: BoundaryTouch,
): { symbols: CodeSymbol[]; basis: ImpactBasis } {
  const own = allSymbolsOf(graph, touch.file);
  const whole = { symbols: own, basis: "whole_file" as const };

  if (touch.symbols !== undefined && touch.symbols !== null && touch.symbols.length > 0) {
    const wanted = new Set(touch.symbols);
    const found = own.filter((s) => wanted.has(s.name));
    const foundNames = new Set(found.map((s) => s.name));
    if ([...wanted].every((name) => foundNames.has(name))) {
      return { symbols: found, basis: "symbol" };
    }
    return whole;
  }

  if (touch.diff === undefined || touch.diff === null) return whole;

  const selected = diffSymbols(graph, touch.file, touch.diff);
  if (selected.wholeFile || selected.symbols.length === 0) {
    return selected.symbols.length > 0 ? { symbols: selected.symbols, basis: "whole_file" } : whole;
  }
  return { symbols: selected.symbols, basis: "symbol" };
}

/**
 * One touch per file, in path order.
 *
 * Path order, so the same session produces the same block twice: a block whose
 * order depends on tool-call sequence looks changed when nothing changed, and
 * the dedupe downstream keys on its content.
 *
 * One per file, because a task edits the same file many times. Names union;
 * and a single edit of that file that could NOT be narrowed makes the whole
 * file the answer — one unplaceable edit is not outvoted by nine placeable
 * ones.
 */
function mergedTouches(touches: readonly BoundaryTouch[]): BoundaryTouch[] {
  const byFile = new Map<string, { names: Set<string>; diffs: string[]; whole: boolean }>();
  for (const touch of touches) {
    let slot = byFile.get(touch.file);
    if (slot === undefined) {
      slot = { names: new Set(), diffs: [], whole: false };
      byFile.set(touch.file, slot);
    }
    if (touch.symbols !== undefined && touch.symbols !== null && touch.symbols.length > 0) {
      for (const name of touch.symbols) slot.names.add(name);
    } else if (typeof touch.diff === "string") {
      slot.diffs.push(touch.diff);
    } else {
      slot.whole = true;
    }
  }

  const merged: BoundaryTouch[] = [];
  for (const [file, slot] of byFile) {
    if (slot.whole) {
      merged.push({ file });
    } else if (slot.diffs.length === 0) {
      merged.push({ file, symbols: [...slot.names].sort() });
    } else if (slot.diffs.length === 1 && slot.names.size === 0) {
      merged.push({ file, diff: slot.diffs[0]! });
    } else {
      // Names AND diffs, or several diffs: no single form carries all of it,
      // and picking one would drop the other's symbols. Whole file.
      merged.push({ file });
    }
  }
  return merged.sort((a, b) => compare(a.file, b.file));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
