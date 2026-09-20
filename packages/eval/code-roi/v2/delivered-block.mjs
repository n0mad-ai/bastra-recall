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
 * The files the block NAMES, repo-relative — the denominator of `block_use`.
 *
 * `renderImpactBlock` prints one candidate per line as `- <location> — <rel>
 * <via>`, and `location` carries a `:line` suffix ONLY when the graph knows a
 * line for the dependent symbol. It does not for a PACKAGE_IMPORT hit
 * (`affected.ts`: `location: importer`) or for a symbol with `line === null`.
 * A pattern that requires `:\d+` therefore drops exactly the cross-package and
 * file-level candidates — and a block made of nothing else parsed as an EMPTY
 * list, which `blockUse` reads as "no block was delivered". That silently
 * shrinks the use denominator the registration puts a minimum on.
 *
 * So the line is split on its separator and the optional line number stripped
 * afterwards. Duplicates are kept: the product's own `listed` is
 * `shown.map((h) => h.file)`, which repeats a file that was hit twice, and the
 * arm's denominator has to be the product's list, not a tidied one.
 */
export function listedFilesOf(note) {
  return [...note.matchAll(/^- (.+?) — /gm)].map((m) => m[1].replace(/:\d+$/, ""));
}

/**
 * The block for one scenario, or `null` where the product would be silent.
 *
 * Silence is a result, not an error: a file the graph does not index and a
 * change nothing depends on are both states the lane really has, and the arm
 * then runs on the bare prompt — which is what the agent would have seen.
 */
export async function deliveredBlockFor(s, tree, graphRoot, prompt) {
  // The kill switch is the FIRST thing `promptImpactNote` checks, and with it
  // set the product returns the same `null` it returns when it has nothing to
  // say. Arm D would then run on the bare prompt in every scenario and the
  // report would read "the product was silent 45 times" — a finding about an
  // environment variable, presented as a finding about the block. So it is an
  // abort, not a silence.
  const { codeAwarenessDisabledByEnv } = await import(`${DIST}enabled-repos.js`);
  if (codeAwarenessDisabledByEnv()) {
    throw new Error(
      "BASTRA_CODE_AWARENESS=off — arm D would be silent everywhere for a reason that has " +
        "nothing to do with the block. Unset it before running the measurement.",
    );
  }
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
  const listed = listedFilesOf(note);
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
