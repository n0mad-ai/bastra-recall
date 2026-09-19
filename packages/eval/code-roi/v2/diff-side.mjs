/**
 * Which SIDE of a diff the measurement's working tree is (#582 counter-review).
 *
 * The product's contract, stated in `affected.ts`: `changedLines` reads the NEW
 * side of the diff (`@@ … +from,count`) because the spans those numbers are
 * looked up in are read off the WORKING TREE — the diff's `b/` side. In real
 * use that holds by construction: `workingDiff` runs `git diff HEAD` in the
 * checkout, so the tree IS the new side.
 *
 * In this measurement it does not hold. A scenario's tree is `git archive` of
 * the commit's PARENT (`run-arms-v3.mjs`), and its diff is
 * `git diff <parent> <commit>` (`mine-repo.mjs:263`) — so the tree is the OLD
 * side while the diff's new side describes a file that does not exist there.
 * Every new-side line is shifted by whatever the earlier hunks inserted, which
 * is the exact failure the product's own comment describes: a change to a
 * second function lands inside the first, the answer comes back non-empty and
 * wrong, and the whole-file fallback that would have found the file never
 * fires. The mutation gate has the same shape: its tree is left CLEAN and the
 * stored diff runs clean → mutated.
 *
 * THE TREE IS NOT MOVED. Applying the diff would make the tree the new side and
 * satisfy the contract, but it would also hand the agent the finished change
 * while the task is to say what a PLANNED change would break — that is the
 * measurement, not a detail of it. So the diff is turned around instead: the
 * reverse of `parent → commit` is `commit → parent`, whose new side is the
 * parent, which is precisely the tree on disk. The product then gets the
 * coordinates it expects, unchanged and unaware.
 *
 * The answer this yields is the right one on its own terms: the symbols asked
 * about are the symbols AS THEY STAND in the tree, which is what "what breaks
 * if I change this" means. The name lane is untouched either way — `diffBody`
 * collects added and removed lines together, so swapping their signs cannot
 * change which names it sees.
 */

/**
 * The same diff, turned around: what was added is removed and the old and new
 * sides trade places.
 *
 * Header lines (`diff --git`, `index`, `similarity`, mode lines) are carried
 * through as they are — `a/` and `b/` name the same path in every diff this
 * measurement produces, and rewriting them would only invent a difference.
 * What must be swapped is what the product actually reads: the `---`/`+++`
 * pair, the hunk ranges, and the sign of every body line.
 *
 * REMOVALS COME BEFORE ADDITIONS in each changed run, the order git writes and
 * `git diff -R` preserves. It is not cosmetic: `changedLines` treats a `-`
 * immediately followed by a `+` as a REPLACEMENT and lets the added lines carry
 * the change, but a `-` with nothing after it as a DELETION and maps it to both
 * of its neighbours. Emitting the flipped lines in place would turn every
 * replacement into a deletion and widen the answer by one line per hunk.
 */
export function reverseUnifiedDiff(diff) {
  const out = [];
  /** The current run of changed lines, already flipped, removals and additions apart. */
  let removed = [];
  let added = [];
  const flush = () => {
    out.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      removed.push(`-${line.slice(1)}`);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("--- ")) {
      added.push(`+${line.slice(1)}`);
      continue;
    }
    // `\ No newline at end of file` belongs to the line before it. It stays
    // inside the run rather than ending it, so the run's order is unaffected
    // and nothing the product reads looks at the marker anyway.
    if (line.startsWith("\\")) {
      (added.length > 0 ? added : removed).push(line);
      continue;
    }
    flush();
    if (line.startsWith("--- ")) {
      out.push(`+++ ${line.slice(4)}`);
      continue;
    }
    if (line.startsWith("+++ ")) {
      out.push(`--- ${line.slice(4)}`);
      continue;
    }
    const hunk = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line);
    out.push(hunk !== null ? `@@ -${hunk[2]} +${hunk[1]} @@${hunk[3]}` : line);
  }
  flush();
  return out.join("\n");
}

/**
 * The diff to hand the product when the tree on disk is the diff's OLD side.
 *
 * Named for what it decides rather than for what it does, so a caller has to
 * say which side its tree is. Every offline caller in this measurement passes
 * `"old"`; a caller whose tree really is the new side passes `"new"` and gets
 * its diff back untouched, which is what a future runner that applies the
 * change into the tree would want.
 */
export function diffForTree(diff, treeSide) {
  if (treeSide === "new") return diff;
  if (treeSide === "old") return reverseUnifiedDiff(diff);
  throw new Error(`diffForTree: treeSide must be "old" or "new", got ${JSON.stringify(treeSide)}`);
}
