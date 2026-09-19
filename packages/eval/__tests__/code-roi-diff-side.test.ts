/**
 * The measurement hands the product the side of the diff its tree really is
 * (#582 counter-review).
 *
 * `changedLines` reads the NEW side of a diff, because the spans those numbers
 * are looked up in come off the working tree. In real use that holds by
 * construction — `workingDiff` is `git diff HEAD` in the checkout. In this
 * measurement it did not: the scenario tree is `git archive` of the PARENT
 * commit while the scenario diff runs parent → commit, so every new-side line
 * was shifted by whatever the earlier hunks had inserted. The mutation gate had
 * the same shape (clean tree, clean → mutated diff).
 *
 * The tree is deliberately NOT moved to the new side: applying the change would
 * show the agent the finished edit, and the task is to say what a PLANNED
 * change would break. The diff is reversed instead, which puts the parent — the
 * tree that is actually on disk — on the new side.
 *
 * The shift is the whole point, so the cases below are built around a diff
 * whose first hunk inserts lines: without the reversal the second hunk's lines
 * come out too high by exactly that many.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { diffForTree, reverseUnifiedDiff } = await import("../code-roi/v2/diff-side.mjs");
const { changedLines } = await import("../../daemon/src/code-graph/affected.js");

/**
 * Parent → commit for one file. The first hunk ADDS two lines at line 10, so
 * everything after it sits two lines lower on the new side than in the parent:
 * the second hunk touches parent line 40, which is new-side line 42.
 */
const FORWARD = [
  "diff --git a/packages/core/src/save.ts b/packages/core/src/save.ts",
  "index 1111111..2222222 100644",
  "--- a/packages/core/src/save.ts",
  "+++ b/packages/core/src/save.ts",
  "@@ -10,0 +10,2 @@ export function first() {",
  "+  const added = 1;",
  "+  const alsoAdded = 2;",
  "@@ -40,1 +42,1 @@ export function second() {",
  "-  return old;",
  "+  return fresh;",
  "",
].join("\n");

describe("reversing a unified diff", () => {
  test("the two sides trade places and every body line flips sign", () => {
    const back = reverseUnifiedDiff(FORWARD).split("\n");
    assert.equal(back[2], "+++ a/packages/core/src/save.ts");
    assert.equal(back[3], "--- b/packages/core/src/save.ts");
    assert.equal(back[4], "@@ -10,2 +10,0 @@ export function first() {");
    assert.equal(back[5], "-  const added = 1;");
    assert.equal(back[6], "-  const alsoAdded = 2;");
    assert.equal(back[7], "@@ -42,1 +40,1 @@ export function second() {");
  });

  test("a replacement keeps git's order: the removal first, the addition after it", () => {
    // `changedLines` reads a `-` followed by a `+` as a replacement and lets the
    // added line carry the change. Flipped in place, the pair would arrive as
    // `+` then `-`, the `-` would read as a deletion, and the answer would gain
    // the neighbouring line of every hunk.
    const back = reverseUnifiedDiff(FORWARD).split("\n");
    assert.equal(back[8], "-  return fresh;");
    assert.equal(back[9], "+  return old;");
  });

  test("the `diff --git` header and the index line are carried through untouched", () => {
    const back = reverseUnifiedDiff(FORWARD).split("\n");
    assert.equal(back[0], "diff --git a/packages/core/src/save.ts b/packages/core/src/save.ts");
    assert.equal(back[1], "index 1111111..2222222 100644");
  });

  test("reversing twice gives the diff back", () => {
    assert.equal(reverseUnifiedDiff(reverseUnifiedDiff(FORWARD)), FORWARD);
  });

  test("a `\\ No newline` marker is left where it is", () => {
    const d = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
    assert.ok(reverseUnifiedDiff(d).includes("\\ No newline at end of file"));
  });

  test("reversing twice gives back a diff with the marker intact", () => {
    const d = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
    assert.equal(reverseUnifiedDiff(reverseUnifiedDiff(d)), d);
  });
});

/**
 * P1.2 (Codex counter-review 3): `---`/`+++` used to be read as a file header
 * wherever their text appeared, hunk content included — a source line that
 * itself starts `-- `/`++ ` reads, diff-prefixed, as `--- x`/`+++ x` and was
 * carried through unflipped instead of being reversed as the body line it is.
 * `reverseUnifiedDiff` now reads the same hunk state machine as the product
 * (`diffLines`, imported from the built daemon package), so the two agree on
 * what counts as a hunk.
 */
describe("reversing a diff whose content looks like a header", () => {
  test("THE REPRODUCTION: a `-- x` / `++ x` pair inside a hunk is flipped as body text, not carried through as headers", () => {
    const diff = ["@@ -10 +11 @@", "--- x", "+++ x"].join("\n");
    const back = reverseUnifiedDiff(diff).split("\n");
    assert.deepEqual(back, ["@@ -11 +10 @@", "-++ x", "+-- x"]);
  });

  test("a multi-line replacement run keeps git's removals-before-additions order after reversal", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -5,2 +5,2 @@",
      "-old1",
      "-old2",
      "+new1",
      "+new2",
    ].join("\n");
    const back = reverseUnifiedDiff(diff).split("\n");
    assert.deepEqual(back.slice(3), ["@@ -5,2 +5,2 @@", "-new1", "-new2", "+old1", "+old2"]);
  });

  test("a pure deletion reverses into a pure insertion with the header swapped", () => {
    const diff = ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", "@@ -5,2 +4,0 @@", "-old1", "-old2"].join(
      "\n",
    );
    const back = reverseUnifiedDiff(diff).split("\n");
    assert.deepEqual(back.slice(3), ["@@ -4,0 +5,2 @@", "+old1", "+old2"]);
  });

  test("a quoted, spaced header pair is still swapped as a header, not read as hunk content", () => {
    const diff = [
      'diff --git "a/weird name.ts" "b/weird name.ts"',
      '--- "a/weird name.ts"',
      '+++ "b/weird name.ts"',
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const back = reverseUnifiedDiff(diff).split("\n");
    assert.deepEqual(back, [
      'diff --git "a/weird name.ts" "b/weird name.ts"',
      '+++ "a/weird name.ts"',
      '--- "b/weird name.ts"',
      "@@ -1,1 +1,1 @@",
      "-new",
      "+old",
    ]);
  });
});

describe("the product reads the side the tree actually is", () => {
  const file = "packages/core/src/save.ts";

  test("the forward diff points at lines the PARENT tree does not have there", () => {
    // 42 is where `second()` sits after the insertion — in the parent it is 40.
    // Looked up in the parent's spans, 42 lands two lines too low.
    const forward = changedLines(FORWARD, file);
    assert.equal(forward.mappable, true);
    assert.deepEqual(forward.lines, [10, 11, 42]);
  });

  test("the reversed diff points at the parent's own line numbers", () => {
    const back = changedLines(diffForTree(FORWARD, "old"), file);
    assert.equal(back.mappable, true);
    // 40 is `second()` in the parent. The insertion has no parent line of its
    // own, so it maps to the two lines it now sits between — the product's rule
    // for a pure deletion, which is what an insertion becomes when reversed.
    assert.deepEqual(back.lines, [10, 11, 40]);
    assert.ok(!back.lines.includes(42), "the shifted line must be gone");
  });

  test("a tree that really is the new side gets its diff unchanged", () => {
    assert.equal(diffForTree(FORWARD, "new"), FORWARD);
  });

  test("the side has to be stated — there is no default to get wrong", () => {
    assert.throws(() => diffForTree(FORWARD, "working"), /treeSide/);
    assert.throws(() => diffForTree(FORWARD, undefined), /treeSide/);
  });
});
