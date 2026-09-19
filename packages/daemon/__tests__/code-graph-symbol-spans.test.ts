/**
 * Where a symbol ends, read off the source — and the constructs that used to
 * get that wrong (#582 review).
 *
 * The span decides whether a changed line is attributed to a symbol or left
 * over for the whole-file fallback, so a span that runs too long loses a
 * dependent silently. These are the cases that made it run too long.
 */
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeSymbol } from "../src/code-graph/reader.js";
import { symbolSpans, spansCovering } from "../src/code-graph/symbol-spans.js";

describe("symbol spans and the constructs that used to break them", () => {
  let spanRoot: string;
  before(async () => {
    spanRoot = await mkdtemp(join(tmpdir(), "bastra-spans-"));
  });
  after(async () => {
    await rm(spanRoot, { recursive: true, force: true });
  });

  const sym = (name: string, line: number): CodeSymbol => ({
    id: `s:${name}`,
    label: name,
    name,
    kind: "function",
    file: "f.ts",
    line,
  });

  const spansOf = async (source: string, symbols: CodeSymbol[]) => {
    const file = `f-${Math.random().toString(36).slice(2)}.ts`;
    await writeFile(join(spanRoot, file), source, "utf8");
    return symbolSpans(spanRoot, file, symbols.map((s) => ({ ...s, file })));
  };

  it("a regex literal holding a brace does not stretch its symbol to the end of the file", async () => {
    // THE REPRODUCTION (#582 review). `/{/` opened a brace the lexer never
    // closed, so `first` ran to the last line, the later top-level change fell
    // INSIDE it, the selection came back non-empty, and the whole-file fallback
    // — the thing that would have found the file — never fired.
    const source = [
      "export function first(s: string): boolean {", // 1
      "  return /{/.test(s);", // 2
      "}", // 3
      "", // 4
      "export function second(): number {", // 5
      "  return 2;", // 6
      "}", // 7
      "", // 8
    ].join("\n");
    const spans = await spansOf(source, [sym("first", 1), sym("second", 5)]);
    assert.notEqual(spans, null, "the file is balanced once the regex is lexed");
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 3],
        [5, 7],
      ],
    );
    // The line a later top-level change touches belongs to `second` alone.
    assert.deepEqual(spansCovering(spans!, 6), ["s:second"]);
    assert.deepEqual(spansCovering(spans!, 4), [], "the gap stays unattributed — the fallback's signal");
  });

  it("still reads `a / b` as a division, not as a regex", async () => {
    const source = [
      "export function ratio(a: number, b: number): number {", // 1
      "  const half = a / b / 2;", // 2
      "  return half;", // 3
      "}", // 4
      "", // 5
      "export function next(): number {", // 6
      "  return 1;", // 7
      "}", // 8
      "", // 9
    ].join("\n");
    // Read as regexes, `/ b / 2;\n  return half;\n}\n\nexport function next(): number {\n` would
    // be swallowed and `ratio` would run past `next`.
    const spans = await spansOf(source, [sym("ratio", 1), sym("next", 6)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 4],
        [6, 8],
      ],
    );
  });

  it("keeps a regex after a keyword and after an operator apart from a division", async () => {
    const source = [
      "export function pick(s: string, n: number): unknown {", // 1
      "  if (n) return /}{/.exec(s);", // 2
      "  const r = n / 2, t = /[/{]/;", // 3
      "  return t.test(s) ? r : 0;", // 4
      "}", // 5
      "", // 6
      "export function after(): number {", // 7
      "  return 7;", // 8
      "}", // 9
      "", // 10
    ].join("\n");
    const spans = await spansOf(source, [sym("pick", 1), sym("after", 7)]);
    assert.notEqual(spans, null, "every brace in those literals is text, so the file balances");
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 5],
        [7, 9],
      ],
    );
  });

  it("reads a regex after a control-flow `)`, where a division would be read after a call", async () => {
    // THE REPRODUCTION (#582 counter-review). `if (x) /{/` was lexed as a
    // division because the `)` before it looks like the end of a value, so the
    // brace opened a block. A later `/}/` at top level closed it again, the
    // file BALANCED, no guard fired — and `f`'s span ran to line 5, swallowing
    // the top-level code below it.
    const source = [
      "export function f(x: boolean, s: string) {", // 1
      "  if (x) /{/.test(s);", // 2
      "}", // 3
      "const top = 1;", // 4
      "if (top) /}/.test(String(top));", // 5
      "", // 6
    ].join("\n");
    const spans = await spansOf(source, [sym("f", 1)]);
    assert.notEqual(spans, null);
    assert.deepEqual(spans!.map((s) => [s.start, s.end]), [[1, 3]]);
    assert.deepEqual(
      spansCovering(spans!, 5),
      [],
      "the top-level line stays unattributed, so the whole-file fallback fires",
    );
  });

  it("reads a regex after the `}` that ENDS A BLOCK, where a division follows an object literal", async () => {
    // THE REPRODUCTION (#582 counter-review 3). After any `}` the lexer left
    // `regexOk` false, so `/{/` at the start of the next statement was read as
    // a division and its brace counted. A second such regex carrying `/}/`
    // cancelled it out: the file BALANCED, no guard fired, and `f`'s span ran
    // to line 7 — swallowing `const top = 1;`, which is the silent loss.
    const source = [
      "export function f() {", // 1
      "  if (x) {}", // 2
      "  /{/.test(s);", // 3
      "}", // 4
      "const top = 1;", // 5
      "if (top) {}", // 6
      "/}/.test(s);", // 7
      "export function g() {}", // 8
      "", // 9
    ].join("\n");
    const spans = await spansOf(source, [sym("f", 1), sym("g", 8)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 4],
        [8, 8],
      ],
    );
    assert.deepEqual(spansCovering(spans!, 5), [], "the top-level line is nobody's, as it must be");
  });

  it("reads a regex after `else` and a block's `}`, and an object literal's `}` as a value", async () => {
    const source = [
      "export function pick(x: boolean, s: string): unknown {", // 1
      "  if (x) { return 1; } else /{}/.test(s);", // 2
      "  const o = { a: 1 };", // 3
      "  return o.a / 2 / 1;", // 4
      "}", // 5
      "", // 6
      "export function tail(): number {", // 7
      "  return 7;", // 8
      "}", // 9
      "", // 10
    ].join("\n");
    const spans = await spansOf(source, [sym("pick", 1), sym("tail", 7)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 5],
        [7, 9],
      ],
    );
  });

  it("does not miscount a class body or a nested template substitution", async () => {
    const source = [
      "export class Box {", // 1
      "  read(s: string): string {", // 2
      "    return `${ {a: 1}.a } ${s}`;", // 3
      "  }", // 4
      "}", // 5
      "", // 6
      "export function below(): number {", // 7
      "  return 7;", // 8
      "}", // 9
      "", // 10
    ].join("\n");
    const spans = await spansOf(source, [sym("Box", 1), sym("read", 2), sym("below", 7)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 5],
        [2, 4],
        [7, 9],
      ],
    );
  });

  it("still divides after a call's `)` and after an index's `]`", async () => {
    const source = [
      "export function rate(n: number, xs: number[]): number {", // 1
      "  return Math.abs(n) / 2 + xs[0] / 3;", // 2
      "}", // 3
      "", // 4
      "export function later(): number {", // 5
      "  return 5;", // 6
      "}", // 7
      "", // 8
    ].join("\n");
    const spans = await spansOf(source, [sym("rate", 1), sym("later", 5)]);
    assert.notEqual(spans, null, "read as regexes, those slashes would swallow `later`");
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 3],
        [5, 7],
      ],
    );
  });

  it("drops the whole file when a top-level block's own body steps back to column zero", async () => {
    // The other half of the runaway: the span overruns code the GRAPH has no
    // symbol for, so `topLevelOverrun` has no neighbour to compare against.
    // A body line at the declaration's own column says the block already ended.
    const source = [
      "export function f(): void {", // 1
      "  run();", // 2
      "}", // 3
      "const after = 1;", // 4
      "call(after);", // 5
      "}", // 6 — a stray brace the count needs, and the span runs to here
      "", // 7
    ].join("\n");
    assert.equal(await spansOf(source, [sym("f", 1)]), null);
  });

  it("does not fault a template literal whose text sits at column zero", async () => {
    const source = [
      "export function help(): string {", // 1
      "  return render(`", // 2
      "usage: bastra code", // 3
      "`);", // 4
      "}", // 5
      "", // 6
    ].join("\n");
    const spans = await spansOf(source, [sym("help", 1)]);
    assert.notEqual(spans, null, "the column of text is not structure");
    assert.deepEqual(spans!.map((s) => [s.start, s.end]), [[1, 5]]);
  });

  it("drops the whole file when the brackets do not balance", async () => {
    // Whatever the cause — a construct this lexer does not know — every span
    // below the mistake is guesswork, so none of them may be used.
    const source = ["export function broken(): void {", "  const s = '{';", "", ""].join("\n");
    assert.equal(await spansOf(source, [sym("broken", 1)]), null);
  });

  it("drops the whole file when a top-level span swallows the next declaration", async () => {
    // A member the graph gives a line of its own, written at column zero, so
    // `table`'s span (1-4) covers `entry`'s start. Two declarations at column
    // zero are siblings; one cannot contain the other, so the count is wrong
    // somewhere and no span from this file may be used.
    const source = [
      "export const table = {", // 1
      '"entry": 1,', // 2
      '"other": 2,', // 3
      "};", // 4
      "", // 5
    ].join("\n");
    assert.equal(await spansOf(source, [sym("table", 1), sym("entry", 2)]), null);
  });

  it("reads a labelled block as a block, so the regex after it is not a division", async () => {
    // THE REPRODUCTION (#582 counter-review 4). `outer: {}` was read as an
    // object literal because of the colon, so its `}` was a value and the next
    // `/{/` divided — counting a brace that is regex text. A second such regex
    // carrying `}` cancelled it out, leaving the file balanced, no guard firing
    // and `f` stretched over two top-level lines it never contained.
    const source = [
      "function f() {", // 1
      "  outer: {}", // 2
      "  /{/.exec(s);", // 3
      "}", // 4
      "inner: {}", // 5
      "/}/.exec(s);", // 6
      "const g = 1;", // 7
      "", // 8
    ].join("\n");
    const spans = await spansOf(source, [sym("f", 1), sym("g", 7)]);
    assert.notEqual(spans, null, "the file is balanced once the labels are blocks");
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 4],
        [7, 7],
      ],
    );
    assert.deepEqual(spansCovering(spans!, 6), [], "line 6 is top level, not inside f");
  });

  it("lexes a template substitution, so a brace inside one never opens a block", async () => {
    // THE SECOND REPRODUCTION (#582 counter-review 4). `${…}` was skipped as
    // template text, so the inner `` `{` `` was read as a bare `{`. One
    // literal carrying `{` and one carrying `}` kept the file balanced while
    // `f` ran a line past its own closing brace.
    const source = [
      "function f() {", // 1
      "  const s = `${true ? `{` : `x`}`;", // 2
      "}", // 3
      "const t = `${true ? `}` : `y`}`;", // 4
      "const g = 1;", // 5
      "", // 6
    ].join("\n");
    const spans = await spansOf(source, [sym("f", 1), sym("g", 5)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 3],
        [5, 5],
      ],
    );
    assert.deepEqual(spansCovering(spans!, 4), [], "line 4 is top level, not inside f");
  });

  it("keeps a switch arm, an arrow's object, a ternary and a type annotation apart", async () => {
    // The constructs the label rule must NOT claim. `case x: {` opens a block,
    // `=> ({})` an object, `? {…} : {…}` two objects, and `x: {a: 1}` a type —
    // all four inside one function, whose span must end on its own brace.
    const source = [
      "function f(x: number) {", // 1
      "  switch (x) {", // 2
      "    case 1: {", // 3
      "      break;", // 4
      "    }", // 5
      "    default:", // 6
      "      break;", // 7
      "  }", // 8
      "  const make = () => ({});", // 9
      "  const pick = x > 0 ? { a: 1 } : { b: 2 };", // 10
      "  const shape: { a: number } = { a: 1 };", // 11
      "  return [make, pick, shape];", // 12
      "}", // 13
      "const g = 2;", // 14
      "", // 15
    ].join("\n");
    const spans = await spansOf(source, [sym("f", 1), sym("g", 14)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 13],
        [14, 14],
      ],
    );
  });

  it("does not end a case head at an object property's colon", async () => {
    const source = [
      "function f(x: unknown) {", // 1
      "  switch (x) {", // 2
      "    case { a: 1 }.a: {", // 3
      "      /{}/.test(String(x));", // 4
      "      break;", // 5
      "    }", // 6
      "  }", // 7
      "}", // 8
      "const g = 2;", // 9
      "", // 10
    ].join("\n");
    const spans = await spansOf(source, [sym("f", 1), sym("g", 9)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 8],
        [9, 9],
      ],
    );
  });

  // The arm's colon has to be READ as the arm's colon, and the test above does
  // not prove that it is: a `case` head misread as a property still balances,
  // because the only thing the reading changes is what the `{` after it opens.
  // A block's `}` lets the next `/` open a regex, an object literal's does not
  // — so a regex AFTER the arm's body is what the misreading loses. Each of
  // these heads made the file unreadable (→ whole file) before the fix.
  for (const [what, head] of [
    ["an object property's colon", "case { a: 1 }.a:"],
    ["a ternary's colon", "case (true ? { x: 1 } : { y: 2 }).x:"],
    ["a colon inside a template expression", "case `${ { a: 1 }.a }`:"],
    ["a colon inside an immediately invoked arrow", "case (() => { return 1 })():"],
  ] as const) {
    it(`ends the case head at the arm's own colon, not at ${what}`, async () => {
      const source = [
        "function f(x: unknown) {", // 1
        "  switch (x) {", // 2
        `    ${head} {`, // 3
        "      break;", // 4
        "    }", // 5
        "    /}/.test(String(x));", // 6
        "  }", // 7
        "}", // 8
        "const g = 2;", // 9
        "", // 10
      ].join("\n");
      const spans = await spansOf(source, [sym("f", 1), sym("g", 9)]);
      assert.notEqual(spans, null, "the arm's body is a block, so line 6 opens a regex");
      assert.deepEqual(
        spans!.map((s) => [s.start, s.end]),
        [
          [1, 8],
          [9, 9],
        ],
      );
    });
  }

  it("keeps an object literal's property a property, even at a statement boundary", async () => {
    // `key: {` sits right after a `{` too — the difference is that the `{` it
    // sits in opened a VALUE. Reading it as a label would make the inner `}`
    // end a statement, and the next `/` a regex.
    const source = [
      "const table = {", // 1
      "  key: {},", // 2
      "};", // 3
      "function f() {", // 4
      "  return 1;", // 5
      "}", // 6
      "", // 7
    ].join("\n");
    const spans = await spansOf(source, [sym("table", 1), sym("f", 4)]);
    assert.notEqual(spans, null);
    assert.deepEqual(
      spans!.map((s) => [s.start, s.end]),
      [
        [1, 3],
        [4, 6],
      ],
    );
  });
});
