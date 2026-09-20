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
 */

import {
  type CodeSymbol,
  type LoadedGraph,
  dependentEdgesOf,
} from "./reader.js";
import { MAX_AFFECTED_FILES, allSymbolsOf, diffSymbols } from "./affected.js";

/**
 * One file the task wrote to.
 *
 * `file` is repo-relative with forward slashes — the same spelling the graph
 * uses. Normalising is the caller's job (`repoRelative` in
 * `dependents-block.ts`) so this module stays a pure function over the graph.
 *
 * `diff` is the unified diff for that file when the caller has one, and null
 * when only the path is known. Null is not a degraded case that gets skipped:
 * it resolves to the whole-file basis, which is the honest reading of "this
 * file changed and I cannot say where".
 */
export interface BoundaryTouch {
  file: string;
  diff: string | null;
}

/** How a touched file's changed symbols were determined. */
export type ImpactBasis = "symbol" | "whole_file";

/** One dependent the task never opened. */
export interface MissedDependent {
  /** The dependent file, repo-relative. */
  file: string;
  /** `file:line` of the depending site, or the file when the graph had no line. */
  location: string;
  /** The changed symbol this hangs off, by bare name. */
  via: string;
  /** Graphify's relation, e.g. `calls`, `imports_from`. */
  relation: string;
  /** Whether `via` came from the diff or from the whole-file fallback. */
  basis: ImpactBasis;
}

export interface BoundaryImpact {
  /** The touched files this was computed over, sorted. */
  touchedFiles: string[];
  /** Bare names of the symbols the task changed, sorted and distinct. */
  changedSymbols: string[];
  /**
   * Dependents of those symbols that live in files the task never wrote to.
   * Empty is the common outcome and the caller must render nothing for it.
   */
  missed: MissedDependent[];
  /** True when `missed` was capped and more dependents exist. */
  truncated: boolean;
}

export interface BoundaryImpactOptions {
  /**
   * Largest `missed` list to return. Defaults to the same cap the per-edit
   * answer uses, so the boundary block cannot be the one that blows the
   * context budget the lane was careful about.
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

  // A file is "opened" if the task wrote to it at all. A dependent living in
  // such a file is not missed even when this task's edit to it was unrelated:
  // the agent had the file in front of it and this module does not claim to
  // know what it read there.
  const touched = new Set<string>();
  for (const touch of touches) {
    touched.add(touch.file);
  }

  const changedNames = new Set<string>();
  const missed: MissedDependent[] = [];
  // A dependent can hang off several changed symbols in the same file. The
  // agent needs the site once; keyed on the site AND the symbol so two genuine
  // reasons to look at one file are not collapsed into one.
  const seen = new Set<string>();
  let truncated = false;

  for (const touch of sortedTouches(touches)) {
    const { symbols, basis } = changedSymbolsFor(graph, touch);
    for (const symbol of symbols) {
      changedNames.add(symbol.name);
    }

    for (const symbol of symbols) {
      for (const edge of dependentEdgesOf(graph, symbol.id)) {
        const dependent = edge.symbol;
        // Self-reference inside the changed file is not a dependent the agent
        // forgot — it is the file it was just editing.
        if (dependent.file === touch.file) continue;
        if (touched.has(dependent.file)) continue;

        const location =
          dependent.line === null ? dependent.file : `${dependent.file}:${dependent.line}`;
        const key = `${location}\u0000${symbol.name}\u0000${edge.relation}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (missed.length >= maxMissed) {
          truncated = true;
          continue;
        }
        missed.push({
          file: dependent.file,
          location,
          via: symbol.name,
          relation: edge.relation,
          basis,
        });
      }
    }
  }

  return {
    touchedFiles: [...touched].sort(),
    changedSymbols: [...changedNames].sort(),
    missed,
    truncated,
  };
}

/**
 * The symbols one touched file changed, and on what basis.
 *
 * The whole-file fallback fires in three cases that are all the same case:
 * the caller had no diff, `diffSymbols` could not narrow, or it narrowed to
 * nothing. The third is the rename shape from #603 — no hunks, so no changed
 * line, so no symbol — and treating it as "nothing changed" would hide a file
 * whose every importer now points at a name that is gone.
 */
function changedSymbolsFor(
  graph: LoadedGraph,
  touch: BoundaryTouch,
): { symbols: CodeSymbol[]; basis: ImpactBasis } {
  if (touch.diff === null) {
    return { symbols: allSymbolsOf(graph, touch.file), basis: "whole_file" };
  }

  const selected = diffSymbols(graph, touch.file, touch.diff);
  if (selected.wholeFile || selected.symbols.length === 0) {
    const whole = selected.symbols.length > 0 ? selected.symbols : allSymbolsOf(graph, touch.file);
    return { symbols: whole, basis: "whole_file" };
  }
  return { symbols: selected.symbols, basis: "symbol" };
}

/**
 * Touches in path order, so the same session produces the same block twice.
 * A block whose order depends on tool-call sequence is a block that looks
 * changed when nothing changed, and the session dedupe downstream keys on its
 * content.
 */
function sortedTouches(touches: readonly BoundaryTouch[]): BoundaryTouch[] {
  return [...touches].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
