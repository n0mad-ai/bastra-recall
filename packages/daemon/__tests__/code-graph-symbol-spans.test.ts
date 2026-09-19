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
});
