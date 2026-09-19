/**
 * Arm D's block: what the UserPromptSubmit lane DELIVERS (#606).
 *
 * WHAT THIS IS. The product's own `promptImpactNote`, from the compiled
 * artefacts the daemon serves, called with the exact scenario prompt, a warm
 * graph cache and an empty session. That is the content path the real prompt
 * lane calls before the first search. The harness does not infer changed
 * symbols from the answer-sheet diff behind the lane's back: the product sees
 * only the same prompt arm A and arm D receive and resolves its paths/symbols
 * with its own intent gate.
 *
 * The cache is warmed because cold-start availability is a separate daemon
 * property already measured by the lane tests. Everything after that remains
 * real lane behaviour: the intent gate may stay silent, ambiguous targets may
 * stay silent, and the product's own 120 ms budget may drop a late block.
 */
import { scenarioRoot } from "./scenario-root.mjs";
const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;

/**
 * The block for one scenario, or `null` where the product would be silent.
 *
 * Silence is a result, not an error: a file the graph does not index and a
 * change nothing depends on are both states the lane really has, and the arm
 * then runs on the bare prompt — which is what the agent would have seen.
 */
export async function deliveredBlockFor(s, tree, graphRoot, prompt) {
  const { CodeGraphCache } = await import(`${DIST}cache.js`);
  const { MAX_IMPACT_FILES } = await import(`${DIST}impact-block.js`);
  const { promptImpactNote } = await import(`${DIST}prompt-impact.js`);
  const repo = scenarioRoot(tree, graphRoot);
  const cache = new CodeGraphCache();
  await cache.ensureLoaded(repo);
  const result = await promptImpactNote({
    prompt,
    cwd: repo,
    session: { shown: {} },
    cache,
  });
  if (result.note === null) return null;
  const note = result.note.note;
  const listed = [...note.matchAll(/^- (.+?):\d+ — /gm)].map((m) => m[1]);
  return {
    note,
    basis: result.note.basis,
    changedSymbols: result.note.changedSymbols,
    listed,
    displayCap: MAX_IMPACT_FILES,
    files: result.note.files,
    truncated: result.note.truncated,
    tokensEst: result.note.tokensEst,
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
