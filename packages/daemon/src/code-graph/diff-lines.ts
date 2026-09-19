/**
 * The one state machine that decides what a unified diff's lines ARE —
 * shared by the product's diff parser (`affected.ts`) and the code-roi
 * measurement's diff reversal (`diff-side.mjs`, imported from the built
 * package the same way `mutation-gate-score.mjs` imports `affected.js`).
 *
 * THE BUG THIS REPLACES (Codex counter-review 3, P1.2). Both places used to
 * treat any line starting `--- ` or `+++ ` as a file header, unconditionally.
 * That is only true OUTSIDE a hunk — before the first `@@` of a file, or
 * right after `diff --git`. A SOURCE line that itself starts `-- ` or `++ `
 * reads, once diff-prefixed, as `--- x` / `+++ x`, and a parser that keys off
 * the text alone skips it as a header: silently, with no signal that a real
 * change was missed. `parseHunkHeader`/`diffLines` fix this once, for both
 * callers, so they cannot drift apart on what counts as a hunk.
 */

/** One side's range in a hunk header, e.g. the `10,2` of `@@ -10,2 +10,0 @@`. */
export interface HunkRange {
  /** Exactly as written — `"10"` or `"10,2"` — so a caller can echo it back. */
  text: string;
  start: number;
  /** 1 when the header omits the count (`@@ -10 +10 @@` means one line each). */
  count: number;
}

function parseRange(text: string): HunkRange {
  const comma = text.indexOf(",");
  return {
    text,
    start: Number(comma < 0 ? text : text.slice(0, comma)),
    count: comma < 0 ? 1 : Number(text.slice(comma + 1)),
  };
}

const HUNK_HEADER = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/;

export interface HunkHeader {
  old: HunkRange;
  new: HunkRange;
  /** Whatever follows the closing `@@` — usually the enclosing function name. */
  trailer: string;
}

/** Parses a `@@ -a,b +c,d @@ …` line, or `null` when `raw` is not one. */
export function parseHunkHeader(raw: string): HunkHeader | null {
  const m = HUNK_HEADER.exec(raw);
  if (m === null) return null;
  return { old: parseRange(m[1]), new: parseRange(m[2]), trailer: m[3] };
}

export type DiffLine =
  | { kind: "file-boundary"; raw: string }
  | { kind: "old-header"; raw: string }
  | { kind: "new-header"; raw: string }
  | { kind: "hunk-header"; raw: string; header: HunkHeader }
  | { kind: "context"; raw: string }
  | { kind: "removed"; raw: string }
  | { kind: "added"; raw: string }
  | { kind: "no-newline"; raw: string }
  | { kind: "other"; raw: string };

/**
 * Walks every line of `diff`, tagging each with what it is under the state
 * machine above rather than what its own text happens to look like.
 *
 * `diff --git ` starts a new file's header zone. `--- `/`+++ ` are headers
 * ONLY in that zone — before the first `@@` of the current file. A
 * `@@ -a,b +c,d @@` line opens a hunk; from there every line is classified
 * purely by its leading character until the next `diff --git`, so a `-`/`+`
 * source line that happens to start `-- `/`++ ` is read as change content,
 * not mistaken for the next file's header.
 */
export function* diffLines(diff: string): Generator<DiffLine> {
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      yield { kind: "file-boundary", raw };
      continue;
    }
    if (!inHunk && raw.startsWith("--- ")) {
      yield { kind: "old-header", raw };
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      yield { kind: "new-header", raw };
      continue;
    }
    const header = parseHunkHeader(raw);
    if (header !== null) {
      inHunk = true;
      yield { kind: "hunk-header", raw, header };
      continue;
    }
    if (inHunk) {
      if (raw.startsWith("+")) {
        yield { kind: "added", raw };
        continue;
      }
      if (raw.startsWith("-")) {
        yield { kind: "removed", raw };
        continue;
      }
      if (raw.startsWith("\\")) {
        yield { kind: "no-newline", raw }; // "\ No newline at end of file"
        continue;
      }
      if (raw.startsWith(" ")) {
        yield { kind: "context", raw };
        continue;
      }
    }
    yield { kind: "other", raw };
  }
}
