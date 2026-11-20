/**
 * Review of 02e4e0f7..fffff172 (P1): the inline elements of a report line were found with one
 * expression whose failed starts each searched to the end of the line, so many openers without a
 * closer ("[" × 32k before an answer marker) blocked the daemon's status read for close to a second
 * and grew fourfold per doubling. Reader and daemon now share one linear scanner
 * (webui views/inline-scan.js).
 *
 * Contract: it gives exactly the expression's matches — same places, same groups — on a fixed corpus
 * and on generated lines over the characters the forms are made of.
 *
 * #1671: a bare web address no longer ends with trailing punctuation (GFM's extended autolinks:
 * ? ! . , : * _ ~, plus ;); the character stays text. The expression's bare group changed with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineMatches } from "../webui/app/js/views/inline-scan.js";
import { asksOwner } from "../src/task-report-status.js";

// The renderer's former expression (bare addresses as of #1671), the reference the scanner must agree with.
const INLINE =
  /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|(https?:\/\/[^\s<)]*[^\s<)?!.,:;*_~])|(^|[^*\w])\*([^*\s][^*]*)\*/g;

const reference = (text: string) => [...text.matchAll(INLINE)].map((m) => ({ index: m.index, groups: [...m] }));
const plain = (ms: { index: number; end: number; groups: (string | undefined)[] }[]) =>
  ms.map(({ index, end, groups }) => {
    assert.equal(end, index + groups[0]!.length);
    return { index, groups: [...groups] };
  });

const CORPUS = [
  "",
  "Paragraph with **bold**, *em*, `code`, a [link](https://example.org/a) and https://example.org/b.",
  "Snake_case and 2*3*4 stay text; *an em * too.",
  "*start* and * not em* and *x*y*",
  "Links: [[known-id]] [[known-id|own label]] [[missing-id]] [[a|]] [[|b]] [[a]x] [[a|b]x",
  "[[x](https://a.b) [](http://a) [a](http:) [a](https:x) [a](httpx:y) [a](ftp://x) [a](http://x y)",
  "http:// https://x<y http://a)b httpsx://a http://",
  "``  `a` ` ``b`` **** ***a*** **a* *",
  "Ship it? [? Yes | No]",
  "Ship it? `[? Yes | No]`",
  "Ship it? [? **Yes** | No]",
  "[*em* in brackets] (*em*) _*em*_ a*b*  *nb*",
  "tab\t*em*\tafter",
  "Open http://127.0.0.1:6723/ui/, then http://a.b/c. Or http://a?b=1&c=2! http://a/b; http://a/b: http://a/b?",
  "http://a.b/c.d?e=f.g,h:i http://a/b_c~d*e http://a/... http://. http://a/b*. **http://a/b** *http://a/b*",
  "(see http://a/b), [http://a/b] http://a/b<c http://a(b http://a.!?",
];

/** Deterministic pseudo-random lines over the characters the forms consist of. */
function* generated(count: number): Generator<string> {
  const alphabet = ["[", "]", "|", "`", "*", "(", ")", "<", " ", "a", "_", " ", "http", "https", ":", "//", "s"];
  let seed = 1536;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let n = 0; n < count; n++) {
    let line = "";
    const length = next() % 24;
    for (let i = 0; i < length; i++) line += alphabet[next() % alphabet.length];
    yield line;
  }
}

test("the shared scanner finds exactly the expression's inline elements", () => {
  for (const line of [...CORPUS, ...generated(20000)]) {
    const want = reference(line);
    assert.deepEqual(plain(inlineMatches(line)), want, JSON.stringify(line));
  }
});

test("#1671: a bare address leaves trailing punctuation as text and keeps it inside", () => {
  const bare = (text: string) => inlineMatches(text).map((m) => m.groups[7]);
  assert.deepEqual(bare("Open http://127.0.0.1:6723/ui/, then"), ["http://127.0.0.1:6723/ui/"]);
  for (const mark of [",", ".", ";", ":", "!", "?", "*", "_", "~", ".)", "?!", "..."]) {
    assert.deepEqual(bare(`See http://a.b/c${mark} more`), ["http://a.b/c"], mark);
    assert.deepEqual(bare(`See http://a.b/c${mark}`), ["http://a.b/c"], `${mark} at the line end`);
  }
  // inside the path or query the same characters belong to the address
  assert.deepEqual(bare("http://a.b/c.d?e=f,g;h:i!j~k_l*m."), ["http://a.b/c.d?e=f,g;h:i!j~k_l*m"]);
  assert.deepEqual(bare("http://127.0.0.1:6723/ui/#tasks?x=1."), ["http://127.0.0.1:6723/ui/#tasks?x=1"]);
  // unchanged: a closing bracket or "<" still ends the address, an address of punctuation alone is none
  assert.deepEqual(bare("(http://a/b) http://a/b<c http://. http://,;"), ["http://a/b", "http://a/b"]);
});

test("openers without a closer before an answer marker cost linear time, not quadratic", () => {
  // On the old expression one 32k prefix took ~0.8 s and 64k ~3 s; linear scanning takes a few ms.
  // The bound is generous so a loaded machine cannot fail it, and still far below the old cost.
  const openers = ["[", "[[", "[a](", "`", "**", "*", " *", "[[a|", " http://.", "http://a.", "http://a/,"];
  const started = performance.now();
  for (const opener of openers) {
    const body = `${opener.repeat(Math.ceil(65536 / opener.length))} Question [? Yes | No]`;
    asksOwner(body); // the daemon's status read
    inlineMatches(body); // the reader's rendering
  }
  const ms = performance.now() - started;
  assert.ok(ms < 1500, `${openers.length} lines of 64k openers took ${ms.toFixed(0)} ms`);
});
