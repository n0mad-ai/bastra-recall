/**
 * Where a symbol ENDS — read off the source, because the graph does not say.
 *
 * Graphify gives every node one `source_location`, `L180`, and no end. The
 * change-impact query needs both: a diff line is only evidence about a symbol
 * if it falls INSIDE it. Attributing a line to "the last symbol that starts at
 * or before it" — the editor-breadcrumb heuristic `affected.ts` used before —
 * gets the gaps wrong, and the gaps are where the doc comments, the top-level
 * constants and the import block live. Measured on the v3 sample, two of the
 * five incomplete scenarios were exactly that: a changed line landed on the
 * wrong symbol, the selection came back non-empty, and a non-empty selection
 * is what suppresses the whole-file fallback that would have found the file.
 *
 * So the span is computed from the file itself, with a bracket balance for
 * anything brace-shaped and an indentation rule for what is not (a multi-line
 * type union, a Python `def`). Both are approximations, and both fail SAFE:
 * a span that is too long over-selects (one extra symbol in the answer), a
 * span that is too short leaves the line unattributed, which the caller reads
 * as "fall back to the whole file". Neither loses a dependent silently.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CodeSymbol } from "./reader.js";

/** Largest source file read for this. Bigger is not a hand-written module. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** One symbol's line range, inclusive, 1-based — the way a diff counts. */
export interface SymbolSpan {
  id: string;
  start: number;
  end: number;
}

/**
 * The spans of the symbols of `file` that have a line, or null when the
 * source cannot be trusted to answer: unreadable, too large, or shorter than
 * a line the graph claims (a graph built against another checkout).
 *
 * Null is not an error — it is the caller's signal to stop narrowing and take
 * the whole file, which is the safe side of this question.
 *
 * File nodes are left out. A file node's "span" is the file, so it would
 * cover every line and no change could ever be outside a symbol.
 */
export function symbolSpans(
  repoRoot: string,
  file: string,
  symbols: readonly CodeSymbol[],
): SymbolSpan[] | null {
  const starts = symbols.filter((s) => s.kind !== "file" && s.line !== null);
  if (starts.length === 0) return [];

  const lines = sourceLines(repoRoot, file);
  if (lines === null) return null;
  const scan = scanSource(lines);

  const spans: SymbolSpan[] = [];
  for (const s of starts) {
    const start = s.line as number;
    if (start > lines.length) return null;
    spans.push({ id: s.id, start, end: spanEnd(scan, start) });
  }
  return spans;
}

/** The ids of every symbol whose span covers `line`. Empty means top level. */
export function spansCovering(spans: readonly SymbolSpan[], line: number): string[] {
  return spans.filter((s) => s.start <= line && line <= s.end).map((s) => s.id);
}

function sourceLines(repoRoot: string, file: string): string[] | null {
  try {
    const buf = readFileSync(resolve(repoRoot, file));
    if (buf.byteLength > MAX_SOURCE_BYTES) return null;
    return buf.toString("utf8").split("\n");
  } catch {
    return null;
  }
}

/** Per line: the bracket balance it contributes, whether it holds code, its indent. */
interface Scan {
  delta: number[];
  blank: boolean[];
  indent: number[];
}

/**
 * Where the symbol that starts at `start` ends, 1-based and inclusive.
 *
 * Two shapes, decided by whether the declaration opens a bracket that is still
 * open at the end of its first line:
 *
 *   OPENS A BLOCK — the end is the line on which the balance returns to zero.
 *     This is what carries a function whose signature spans four lines and a
 *     class whose methods are symbols of their own (the class span contains
 *     them, and a line inside a method belongs to both, which is correct).
 *   OPENS NOTHING — a one-liner, or a declaration continued by indentation
 *     (`export type CapReason =` and its union arms). The end is the last
 *     following line that is non-blank and indented deeper than the
 *     declaration itself.
 */
function spanEnd(scan: Scan, start: number): number {
  const n = scan.delta.length;
  const first = start - 1;
  let depth = 0;
  let opened = false;
  for (let i = first; i < n; i++) {
    depth += scan.delta[i];
    if (depth > 0) {
      opened = true;
      continue;
    }
    if (opened) return i + 1;
    if (i > first && (scan.blank[i] || scan.indent[i] <= scan.indent[first])) return i;
  }
  return n;
}

/**
 * The bracket balance of each line, with comments and string literals taken
 * out first — a brace in a doc comment or in a template literal is text, and
 * counting it would move every span below it.
 *
 * Block comments and template literals carry their state across lines, which
 * is the whole reason this is one pass over the file rather than a per-line
 * regex. Regular expression literals are NOT parsed: `/\}/` counts a brace it
 * should not. That mis-counts the span of the symbol it sits in, and both
 * directions of that error are safe (see the module comment).
 */
function scanSource(lines: readonly string[]): Scan {
  const delta: number[] = [];
  const blank: boolean[] = [];
  const indent: number[] = [];
  let inBlockComment = false;
  let inTemplate = false;

  for (const raw of lines) {
    let d = 0;
    let sawCode = false;
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (inBlockComment) {
        if (c === "*" && raw[i + 1] === "/") {
          inBlockComment = false;
          i += 2;
        } else i++;
        continue;
      }
      if (inTemplate) {
        if (c === "\\") i += 2;
        else if (c === "`") {
          inTemplate = false;
          i++;
        } else i++;
        sawCode = true;
        continue;
      }
      if (c === "/" && raw[i + 1] === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (c === "/" && raw[i + 1] === "/") break;
      if (c === "`") {
        inTemplate = true;
        sawCode = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        i = endOfString(raw, i, c);
        sawCode = true;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") d--;
      if (c.trim().length > 0) sawCode = true;
      i++;
    }
    delta.push(d);
    blank.push(!sawCode);
    indent.push(raw.length - raw.trimStart().length);
  }
  return { delta, blank, indent };
}

/** Index just past a quoted string. An unterminated one ends at the line end. */
function endOfString(raw: string, from: number, quote: string): number {
  for (let i = from + 1; i < raw.length; i++) {
    if (raw[i] === "\\") i++;
    else if (raw[i] === quote) return i + 1;
  }
  return raw.length;
}
