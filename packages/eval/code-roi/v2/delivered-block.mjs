/**
 * Arm D's block: what the Write/Edit lane would have DELIVERED (#606).
 *
 * WHAT THIS IS. The product's own `renderImpactBlock`, fed by the product's own
 * `diffSymbols` / `affectedHits` / `narrowPackageHits` / `affectedResult` /
 * `displayOrder`, from `packages/daemon/dist` — the same compiled artefacts the
 * daemon serves. Nothing here writes block text: the lead lines are imported
 * (`WRITE_LEAD_SYMBOLS`, `WRITE_LEAD_WHOLE_FILE`), the cap is the product's
 * `MAX_IMPACT_FILES`, and what the arm reads is therefore the product's block
 * and not an idealisation of it. That is the registered claim of this arm and
 * this module is where it is kept true.
 *
 * WHY NOT `impactNote()` ITSELF. Three things it needs the harness cannot give
 * it honestly:
 *
 *   1. A TOOL CALL. `impactNote` reads the pending change out of a Write/Edit
 *      `tool_input` through `pending-diff.ts`. A scenario has a git diff, not a
 *      tool call. Rebuilding one as a whole-file Write would go through
 *      `unifiedDiff`'s single trimmed hunk, which is deliberately WIDER than
 *      the change (see `pending-diff.ts`): a change to two distant functions
 *      would arrive as one hunk spanning everything between them. The scenario
 *      diff read directly through `diffSymbols` is the narrow case — the block
 *      an agent gets when it edits with Edit rather than rewriting the file —
 *      and it is the same entry point `impactNote` reaches one line later.
 *   2. THE DIFF SIDE. The scenario tree is the commit's PARENT while the diff
 *      runs parent → commit, so the diff's new side describes a file that is
 *      not on disk. `diffForTree(diff, "old")` turns it around, exactly as the
 *      prefilled arm of registration 6 does. `impactNote` has no way to be told
 *      this and should not: in real use the working tree IS the old side and
 *      the pending text the new one, which is the case it is written for.
 *   3. THE SESSION. Dedupe, the cold-cache path and the 120 ms budget are
 *      lane behaviour, not block content. An arm is run once per scenario in a
 *      fresh process, so a dedupe hit is impossible and a budget overrun would
 *      drop a block for a reason that has nothing to do with the measurement.
 *
 * WHAT THE ARM IS THEREFORE NOT MEASURING: the lane's delivery rate. Whether
 * the lane fires is the daemon's decision and counting it would let the
 * measurement answer itself (`success_is_use_not_delivery` in the
 * registration). This module answers only "what would the block have said",
 * and the run answers "did it help".
 */
import { scenarioRoot } from "./scenario-root.mjs";
import { diffForTree } from "./diff-side.mjs";

const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;

/**
 * The block for one scenario, or `null` where the product would be silent.
 *
 * Silence is a result, not an error: a file the graph does not index and a
 * change nothing depends on are both states the lane really has, and the arm
 * then runs on the bare prompt — which is what the agent would have seen.
 */
export async function deliveredBlockFor(s, tree, graphRoot) {
  const { loadGraph } = await import(`${DIST}reader.js`);
  const { affectedHits, affectedResult, allSymbolsOf, diffSymbols, narrowPackageHits } = await import(
    `${DIST}affected.js`
  );
  const { displayOrder, renderImpactBlock, MAX_IMPACT_FILES, WRITE_LEAD_SYMBOLS, WRITE_LEAD_WHOLE_FILE } =
    await import(`${DIST}impact-block.js`);

  const repo = scenarioRoot(tree, graphRoot);
  const loaded = await loadGraph(repo);
  if (!loaded.ok) throw new Error(`delivered: graph ${loaded.reason}`);
  const graph = loaded.graph;
  if (!graph.symbolsByFile.has(s.file)) return null;

  // `fromDiff` in impact-block.ts, line for line: a narrowed selection when the
  // diff placed its lines inside symbols, the whole file when it did not.
  const picked = diffSymbols(graph, s.file, diffForTree(s.diff, "old"));
  const selection =
    !picked.wholeFile && picked.symbols.length > 0
      ? { basis: "diff", symbols: picked.symbols }
      : {
          basis: "whole_file",
          symbols: picked.wholeFile ? picked.symbols : allSymbolsOf(graph, s.file),
        };
  if (selection.symbols.length === 0) return null;

  const names = selection.symbols.filter((x) => x.kind !== "file").map((x) => x.name);
  const hits = await narrowPackageHits(repo, affectedHits(graph, s.file, selection.symbols, 1), names);
  const result = affectedResult(selection.symbols, hits);
  if (result.files.length === 0) return null;

  const shown = displayOrder(result.hits);
  // `stale: false` — the graph was built from this very tree moments ago by the
  // runner, so the lane's staleness line would be false here and printing it
  // would put a sentence in the arm's prompt that the product would not.
  const note = renderImpactBlock({
    file: s.file,
    basis: selection.basis,
    changed: result.changedSymbols,
    hits: shown,
    total: result.hits.length,
    stale: false,
    lead: selection.basis === "whole_file" ? WRITE_LEAD_WHOLE_FILE : WRITE_LEAD_SYMBOLS,
  });
  return {
    note,
    basis: selection.basis,
    changedSymbols: result.changedSymbols,
    // The files the block NAMES — the denominator of `block_use_floor`. Not
    // `result.files`: a candidate the block never printed cannot have been
    // used, and counting it would punish the arm for the display cap.
    listed: shown.map((h) => h.file),
    displayCap: MAX_IMPACT_FILES,
    files: result.files.length,
    truncated: result.truncated,
    tokensEst: Math.ceil(note.length / 4),
  };
}

/**
 * The arm's prompt: the block first, the task after.
 *
 * The block goes BEFORE the question because that is where the lane puts it —
 * it arrives with the tool call, ahead of anything the agent does next. Nothing
 * is said about it: the product delivers the block bare, and an instruction
 * here ("use this") would measure an instruction the product does not give.
 */
export function promptWithDeliveredBlock(basePrompt, block) {
  if (block === null) return basePrompt;
  return [block.note, "", basePrompt].join("\n");
}
