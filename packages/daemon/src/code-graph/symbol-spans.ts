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
 * type union, a Python `def`). Both are approximations. A span that is too
 * SHORT fails safe: the line stays unattributed, which the caller reads as
 * "fall back to the whole file". A span that is too LONG does not, and an
 * earlier version of this file claimed it did (#582 review). An over-long span
 * swallows a later top-level change, attributes it to the wrong symbol and
 * hands back a confident non-empty selection — precisely what suppresses the
 * fallback. So the long direction is guarded twice: the lexer handles the
 * construct that caused it (regex literals), and whatever it still gets wrong
 * surfaces as an unbalanced file or as a top-level span overrunning its
 * neighbour, and then the whole file is taken. Precision is the cheaper loss.
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
  // The lexer is an approximation, and an approximation that got the brackets
  // wrong somewhere leaves the file unbalanced. Then every span below the
  // mistake is wrong too, so no span from this file may be trusted (#582).
  if (scan.delta.reduce((a, b) => a + b, 0) !== 0) return null;

  const spans: SymbolSpan[] = [];
  for (const s of starts) {
    const start = s.line as number;
    if (start > lines.length) return null;
    spans.push({ id: s.id, start, end: spanEnd(scan, start) });
  }
  return topLevelOverrun(scan, spans) ? null : spans;
}

/**
 * Does a top-level span swallow the next top-level declaration?
 *
 * Two declarations at column zero are siblings — the first cannot contain the
 * second. When its computed span says otherwise, the bracket count ran away
 * (an unlexed construct, a graph built against another checkout), and the line
 * attribution below that point is guesswork. The caller is told to take the
 * whole file instead, which is the side that loses no dependent.
 *
 * Only column-zero starts are compared: a class at column zero legitimately
 * contains its own methods, and those start indented.
 */
function topLevelOverrun(scan: Scan, spans: readonly SymbolSpan[]): boolean {
  const top = spans
    .filter((s) => scan.indent[s.start - 1] === 0)
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < top.length - 1; i++) {
    const next = top.find((s) => s.start > top[i].start);
    if (next !== undefined && top[i].end >= next.start) return true;
  }
  return false;
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
 * regex.
 *
 * REGULAR EXPRESSION LITERALS ARE LEXED, because leaving them out was not the
 * safe approximation the earlier comment here claimed (#582 review). A `/{/`
 * inside a function opens a brace that never closes, so that function's span
 * runs to the end of the file, a LATER top-level change lands inside it, the
 * selection comes back non-empty — and a non-empty selection is exactly what
 * suppresses the whole-file fallback. The error direction is not symmetric:
 * that one loses a dependent silently.
 *
 * `/` is ambiguous between division and a regex, and the ambiguity is resolved
 * the way every JavaScript lexer resolves it: by what came BEFORE. After a
 * value — an identifier, a number, a string, `)`, `]`, `}` — it divides; after
 * an operator, a comma, an opening bracket or one of the keywords below, it
 * opens a regex. What is left over is caught by the balance check in
 * `symbolSpans`, which drops the whole file rather than trust a bad count.
 */
const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** May a `/` here open a regex literal? `prevWord` is set when the last token was one. */
function regexAllowed(prevSig: string, prevWord: string): boolean {
  if (prevSig === "") return true;
  if (prevWord !== "") return REGEX_AFTER_KEYWORD.has(prevWord);
  return !")]}".includes(prevSig) && !/[A-Za-z0-9_$]/.test(prevSig);
}

/**
 * Index just past a regex literal starting at `from`, or null when the line
 * ends first — a literal cannot span lines, so that `/` was a division after
 * all. Character classes are honoured: `/[/]/` closes at the LAST slash.
 */
function endOfRegex(raw: string, from: number): number | null {
  let inClass = false;
  for (let i = from + 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") i++;
    else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") inClass = true;
    else if (c === "/") {
      let j = i + 1;
      while (j < raw.length && /[a-z]/.test(raw[j])) j++;
      return j;
    }
  }
  return null;
}

function scanSource(lines: readonly string[]): Scan {
  const delta: number[] = [];
  const blank: boolean[] = [];
  const indent: number[] = [];
  let inBlockComment = false;
  let inTemplate = false;
  // The last significant token, carried ACROSS lines: `a\n  / b` divides.
  let prevSig = "";
  let prevWord = "";

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
          prevSig = "`";
          prevWord = "";
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
      if (c === "/" && regexAllowed(prevSig, prevWord)) {
        const end = endOfRegex(raw, i);
        if (end !== null) {
          i = end;
          sawCode = true;
          prevSig = "/";
          prevWord = "";
          continue;
        }
        // No closing slash on this line: not a literal, so fall through and
        // treat it as the operator it must have been.
      }
      if (c === "`") {
        inTemplate = true;
        sawCode = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        i = endOfString(raw, i, c);
        sawCode = true;
        prevSig = c;
        prevWord = "";
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < raw.length && /[A-Za-z0-9_$]/.test(raw[j])) j++;
        prevWord = raw.slice(i, j);
        prevSig = raw[j - 1];
        sawCode = true;
        i = j;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") d--;
      if (c.trim().length > 0) {
        sawCode = true;
        prevSig = c;
        prevWord = "";
      }
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
