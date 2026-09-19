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
 * fallback. So the long direction is guarded three times: the lexer handles the
 * construct that caused it (regex literals, including the `)` that decides
 * whether a slash is one), and whatever it still gets wrong surfaces as an
 * unbalanced file, as a top-level span overrunning its neighbour, or as a
 * top-level block whose own body steps back to column zero before its end —
 * and then the whole file is taken. Precision is the cheaper loss.
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
  // A closer with nothing open is a count this lexer cannot explain, even when
  // a later opener happens to even the total out. Conservative: take the whole
  // file rather than trust spans built on a stack that underflowed (#582 c-r 4).
  if (scan.ambiguous) return null;

  const spans: SymbolSpan[] = [];
  for (const s of starts) {
    const start = s.line as number;
    if (start > lines.length) return null;
    const { end, opened, openedAt } = spanEnd(scan, start);
    if (opened && scan.indent[start - 1] === 0 && runsPastItsOwnEnd(scan, openedAt, end, start)) {
      return null;
    }
    spans.push({ id: s.id, start, end });
  }
  return topLevelOverrun(scan, spans) ? null : spans;
}

/**
 * Does a top-level block that runs to the END OF THE FILE contain a line that
 * says it ended earlier?
 *
 * `topLevelOverrun` catches a runaway span by the neighbour it swallows, and
 * has one blind spot: the LAST symbol of a file has no neighbour below it. A
 * span that ran away there simply reaches the last line, and the top-level code
 * it swallowed on the way — an import, a constant, a call the graph has no
 * symbol for — is silently attributed to it (#582 counter-review).
 *
 * What the balance got wrong shows in the layout: a block written at column
 * zero indents its body, so a line inside the span that STARTS A STATEMENT at
 * that same column — `const x = 1;`, `import …`, `call(x);` — is code the
 * block never contained.
 *
 * "Starts a statement" is read narrowly, as a line beginning with a word
 * character. Everything a declaration can legitimately put at column zero is a
 * continuation of its own head and begins with a bracket instead: `): string {`
 * for a signature broken over several lines, `} = {}): Promise<T> {` for an
 * options object, `} {` for a multi-line return type. Reading those as
 * statements faulted 102 of this repository's own 737 indexed files.
 *
 * ONLY for a span that reaches the end of the file, because that is the blind
 * spot. Applying the same test everywhere was measured on the 44-scenario
 * sample at 3.6 points of precision for no recall and no completeness, which
 * is the wrong side of this file's trade: those spans have a neighbour, and the
 * neighbour check already covers them.
 *
 * Blank lines and lines that BEGIN inside a template literal or a block
 * comment are exempt: their column is text, not structure.
 */
function runsPastItsOwnEnd(scan: Scan, openedAt: number, end: number, start: number): boolean {
  for (let i = end; i < scan.delta.length; i++) {
    if (!scan.blank[i]) return false; // something follows: the neighbour check owns this
  }
  // From the line the block OPENS on, not from the symbol's own start: the
  // graph points a symbol at its doc comment often enough, and the declaration
  // line below that comment is a statement at column zero like any other.
  for (let line = openedAt + 1; line < end; line++) {
    const i = line - 1;
    if (scan.blank[i] || scan.inText[i] || !scan.statement[i]) continue;
    if (scan.indent[i] <= scan.indent[start - 1]) return true;
  }
  return false;
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
  /** Whether the line BEGINS inside a template literal or a block comment. */
  inText: boolean[];
  /** Whether the line's first character starts a word — a statement, not a closer. */
  statement: boolean[];
  /** A closer arrived with nothing open: the count cannot be trusted at all. */
  ambiguous: boolean;
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
function spanEnd(scan: Scan, start: number): { end: number; opened: boolean; openedAt: number } {
  const n = scan.delta.length;
  const first = start - 1;
  let depth = 0;
  let opened = false;
  let openedAt = start;
  for (let i = first; i < n; i++) {
    depth += scan.delta[i];
    if (depth > 0) {
      if (!opened) openedAt = i + 1;
      opened = true;
      continue;
    }
    if (opened) return { end: i + 1, opened, openedAt };
    if (i > first && (scan.blank[i] || scan.indent[i] <= scan.indent[first])) {
      return { end: i, opened, openedAt };
    }
  }
  return { end: n, opened, openedAt };
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
 *
 * `)` IS TWO DIFFERENT TOKENS, and reading them as one was the same bug over
 * again (#582 counter-review): `a(b) / c` divides, `if (x) /{/.test(s)` does
 * not. So every open bracket is pushed on a stack that remembers whether its
 * `(` closed a CONTROL-FLOW head, and only that kind of `)` lets a regex
 * follow. Without it `if (x) /{/…` opened a brace that never closed, and the
 * miscount could be cancelled out by a later `/}/` — leaving a balanced file,
 * a span running past the end of its function, and a top-level change
 * attributed to it. That is the silent-loss direction, not the safe one.
 *
 * `}` IS TWO DIFFERENT TOKENS FOR THE SAME REASON (#582 counter-review 3). The
 * `}` that ends a BLOCK ends a statement, so the next `/` opens a regex; the
 * `}` that ends an OBJECT LITERAL is a value, so the next `/` divides. Treating
 * every `}` as a value left `if (x) {}` followed by `/{/…` reading that regex
 * as a division — and two such regexes, one carrying `{` and one carrying `}`,
 * cancel out: the file stays balanced, no guard fires, and the span before them
 * quietly swallows the top-level code that follows. So the stack remembers per
 * `{` which one it was, decided by the token in front of it: after `)`, `=>`,
 * `else`/`do`/`try`/`finally`, a `class`/`interface`/`enum`/`namespace` head,
 * or at the start of a statement it is a block; anywhere else — after `=`, `(`,
 * `,`, `:`, `[`, `return` — it is a value.
 */
const CONTROL_FLOW_HEAD = new Set(["if", "while", "for", "with", "switch", "catch"]);

/**
 * `${` OPENS CODE, AND CODE HAS BRACES (#582 counter-review 4). Skipping a
 * template literal wholesale reads `` `${x ? `{` : `y`}` `` as: template, then
 * a bare `{`, then template — one brace opened and never closed. A second such
 * literal carrying `}` cancels it out, so the file stays balanced, no guard
 * fires, and the span in between quietly runs past its function. So `${` pushes
 * an expression context with its own place on the bracket stack, the `}` at
 * that level pops back into the template text, and the nesting is unlimited.
 *
 * A LABEL IS NOT A PROPERTY (#582 counter-review 4). `outer: { … }` is a block,
 * and reading its `}` as an object literal's — a value — made the next `/` a
 * division, so `/{/` counted a brace that was regex text. The colon is
 * classified instead of assumed: a pending `?` at the same bracket level makes
 * it a ternary (and an optional `a?: T` its own well-formed case), a `case`
 * head makes it a switch arm, and otherwise `identifier :` directly after a
 * statement boundary, inside a block rather than an object literal, is a label.
 * Everything else — `const x: {a: 1}`, `{ key: {} }`, `(a: T) => …` — keeps the
 * property reading it had.
 */

/** What an open bracket was, so that its closer knows what it produced. */
type BracketKind = "ctrl-paren" | "expr-paren" | "block" | "value" | "tmpl-expr";

/** Tokens after which `identifier :` is a label rather than a property. */
const STATEMENT_BOUNDARY = new Set(["", ";", "{", "}"]);

/** Tokens after which a `{` opens a block rather than an object literal. */
const BLOCK_BEFORE = new Set(["", ";", "{", "}", ")", "=>", "else", "do", "try", "finally"]);

/** Keywords whose head runs on — over a name, generics, `extends` — to a block. */
const BLOCK_DECLARATION = new Set(["class", "interface", "enum", "namespace", "module"]);

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

/**
 * What an opening bracket opens, read off the token in front of it.
 *
 * Only `{` is genuinely ambiguous, and only its answer is load-bearing: a
 * block's `}` ends a statement, an object literal's `}` is a value. `[` always
 * produces a value, and a `(` is told apart by the control-flow keyword that
 * may head it.
 */
function openedKind(open: string, lastTok: string, declHead: boolean): BracketKind {
  if (open === "(") return CONTROL_FLOW_HEAD.has(lastTok) ? "ctrl-paren" : "expr-paren";
  if (open === "[") return "value";
  return BLOCK_BEFORE.has(lastTok) || declHead ? "block" : "value";
}

function scanSource(lines: readonly string[]): Scan {
  const delta: number[] = [];
  const blank: boolean[] = [];
  const indent: number[] = [];
  const inText: boolean[] = [];
  const statement: boolean[] = [];
  let ambiguous = false;
  let inBlockComment = false;
  let inTemplate = false;
  // May the NEXT `/` open a regex? Carried across lines: `a\n  / b` divides.
  // True at the start of a file, where no value can precede the slash.
  let regexOk = true;
  // The token immediately before the current one: an identifier's text, a
  // single punctuation character, `=>`, or "lit" for a string, template or
  // regex literal. `if` before `(`, `)` before `{`. Empty at the start of the
  // file, which is also a statement start.
  let lastTok = "";
  // The token before `lastTok`, which is what tells `outer: {` (a label, after a
  // statement boundary) from `key: {` (a property, after `,` or `(`).
  let prevTok = "";
  // Inside a `case` head, where the `:` that follows ends a statement rather
  // than introducing a value. `default:` needs no flag — it is a bare word.
  let caseHead = false;
  // Pending `?` per bracket level: the next `:` at that level closes a ternary
  // or an optional marker, and is therefore never a label.
  const ternary: number[] = [0];
  // Inside the head of a `class`/`interface`/`enum`/`namespace`, where the name,
  // the generics and an `extends` clause still sit between the keyword and the
  // block it opens. Cleared by anything that cannot be part of such a head.
  let declHead = false;
  // One entry per open bracket, remembering what it opened — its closer needs
  // to know whether it produced a value (`/` divides) or ended a statement
  // (`/` opens a regex).
  const brackets: BracketKind[] = [];

  for (const raw of lines) {
    let d = 0;
    let sawCode = false;
    let i = 0;
    inText.push(inBlockComment || inTemplate);
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
          regexOk = false;
          prevTok = lastTok;
          lastTok = "lit";
          i++;
        } else if (c === "$" && raw[i + 1] === "{") {
          // An expression, with its own bracket stack. Neither this `${` nor
          // the `}` that closes it counts towards the brace balance.
          inTemplate = false;
          brackets.push("tmpl-expr");
          ternary.push(0);
          regexOk = true;
          prevTok = "";
          lastTok = "";
          i += 2;
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
      if (c === "/" && regexOk) {
        const end = endOfRegex(raw, i);
        if (end !== null) {
          i = end;
          sawCode = true;
          regexOk = false;
          lastTok = "lit";
          continue;
        }
        // No closing slash on this line: not a literal, so fall through and
        // treat it as the operator it must have been.
      }
      // The `}` that closes a `${…}` returns to the template text it opened in.
      if (c === "}" && brackets[brackets.length - 1] === "tmpl-expr") {
        brackets.pop();
        ternary.pop();
        inTemplate = true;
        regexOk = false;
        prevTok = lastTok;
        lastTok = "lit";
        sawCode = true;
        i++;
        continue;
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
        regexOk = false;
        // A string in a declaration head is still a head: `declare module "x" {`.
        prevTok = lastTok;
        lastTok = "lit";
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < raw.length && /[A-Za-z0-9_$]/.test(raw[j])) j++;
        const word = raw.slice(i, j);
        regexOk = REGEX_AFTER_KEYWORD.has(word);
        if (BLOCK_DECLARATION.has(word)) declHead = true;
        if (word === "case") caseHead = true;
        prevTok = lastTok;
        lastTok = word;
        sawCode = true;
        i = j;
        continue;
      }
      if (c === "?" && raw[i + 1] !== "?" && raw[i + 1] !== "." && lastTok !== "?") {
        ternary[ternary.length - 1]++;
      }
      if (c === ":") {
        const label = colonEndsStatement(
          ternary,
          brackets[brackets.length - 1],
          lastTok,
          prevTok,
          caseHead,
        );
        if (label) {
          // A label's or a `case` arm's colon ends a statement, so what follows
          // is a statement start: `{` opens a block, `/` opens a regex.
          caseHead = false;
          prevTok = ";";
          lastTok = ";";
        } else {
          prevTok = lastTok;
          lastTok = ":";
        }
        regexOk = true;
        sawCode = true;
        i++;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        d++;
        brackets.push(openedKind(c, lastTok, declHead));
        ternary.push(0);
        if (c === "{") declHead = false;
        regexOk = true;
      } else if (c === ")" || c === "]" || c === "}") {
        d--;
        if (brackets.length === 0) ambiguous = true;
        const kind = brackets.pop();
        if (ternary.length > 1) ternary.pop();
        // `if (x) /re/` and `if (x) {}\n/re/` open a regex; `f(x) / 2`,
        // `xs[i] / 2` and `{a: 1} / 2` divide. An unmatched closer leaves the
        // file unbalanced and no span from it survives anyway.
        regexOk = kind === "ctrl-paren" || kind === "block";
      } else if (c.trim().length > 0) {
        // Operators, punctuation and the like take a regex; a digit is a value.
        regexOk = !/[0-9]/.test(c);
      }
      if (c.trim().length > 0) {
        // `=` then `>` is the arrow, whose `{` is a body and never an object.
        const tok = c === ">" && lastTok === "=" ? "=>" : c;
        if (tok !== "=>") prevTok = lastTok;
        lastTok = tok;
        if (c === ";" || c === "=" || c === "(" || c === ",") declHead = false;
        if (c === ";" || c === "{" || c === "}") caseHead = false;
        sawCode = true;
      }
      i++;
    }
    delta.push(d);
    statement.push(/^[A-Za-z_$@#]/.test(raw.trimStart()));
    blank.push(!sawCode);
    indent.push(raw.length - raw.trimStart().length);
  }
  return { delta, blank, indent, inText, statement, ambiguous };
}

/**
 * Does this `:` end a statement — a label or a `case`/`default` arm — rather
 * than introduce a value?
 *
 * The three readings are decided in order of certainty. A pending `?` at this
 * bracket level is a ternary or an optional marker and settles it outright. A
 * `case` head settles it the other way. What is left is a label only when an
 * identifier sits directly after a statement boundary AND the enclosing
 * bracket is a block rather than an object literal — which is what keeps
 * `{ key: {} }` a property and `outer: {}` a label.
 */
function colonEndsStatement(
  ternary: number[],
  frame: BracketKind | undefined,
  lastTok: string,
  prevTok: string,
  caseHead: boolean,
): boolean {
  if (ternary[ternary.length - 1] > 0) {
    ternary[ternary.length - 1]--;
    return false;
  }
  if (caseHead) return true;
  const inBlock = frame === undefined || frame === "block";
  const isName = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(lastTok) && lastTok !== "lit";
  return inBlock && isName && STATEMENT_BOUNDARY.has(prevTok);
}

/** Index just past a quoted string. An unterminated one ends at the line end. */
function endOfString(raw: string, from: number, quote: string): number {
  for (let i = from + 1; i < raw.length; i++) {
    if (raw[i] === "\\") i++;
    else if (raw[i] === quote) return i + 1;
  }
  return raw.length;
}
