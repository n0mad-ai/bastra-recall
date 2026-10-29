/**
 * #1309 — copy blocks: split at useful boundaries, never inside a grapheme
 * cluster, counts outside the payload, lossless reconstruction, and a receipt
 * bound to the artifact and every contract field.
 *
 * Revert-check: drop the `isBoundary` test in the cut search — the ZWJ and
 * combining-mark cases go red; drop a field from `copyBlocksReceipt` — the
 * receipt-per-parameter case goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCopyBlocks,
  copyBlocksReceipt,
  renderForChat,
  countCopyUnits,
  type CopyBlocksInput,
  type CopyBlocksResult,
} from "../src/copy-blocks.js";

const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 7 code points, 11 UTF-16 units

function run(text: string, extra: Partial<CopyBlocksInput> = {}): CopyBlocksResult {
  return validateCopyBlocks({ text, channel: "test", limit: 2000, normalize: "none", unit: "codepoints", ...extra });
}

function rebuild(r: CopyBlocksResult): string {
  return r.blocks.map((b) => b.payload + (r.separators.find((s) => s.after_block === b.index)?.text ?? "")).join("");
}

function graphemeStarts(text: string): Set<number> {
  const set = new Set<number>([text.length]);
  for (const s of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)) set.add(s.index);
  return set;
}

function assertSound(r: CopyBlocksResult, canonical: string): void {
  assert.equal(r.reconstruction_ok, true);
  assert.equal(rebuild(r), canonical);
  const starts = graphemeStarts(canonical);
  for (const b of r.blocks) {
    assert.equal(canonical.slice(b.start, b.end), b.payload);
    assert.ok(starts.has(b.start) && starts.has(b.end), `block ${b.index} cuts a grapheme cluster`);
    assert.equal(b.count, countCopyUnits(b.payload, r.unit_applied));
  }
}

test("1999 and 2000 units fit in one block, 2001 splits at the last word boundary", () => {
  for (const n of [1999, 2000]) {
    const text = "word ".repeat(400).slice(0, n);
    const r = run(text);
    assert.equal(r.blocks.length, 1, `${n}`);
    assert.equal(r.blocks[0]!.count, n);
    assert.ok(r.receipt);
    assertSound(r, text);
  }
  const text = "word ".repeat(400) + "x"; // 2001
  const r = run(text);
  assert.equal(r.blocks.length, 2);
  assert.ok(r.blocks.every((b) => b.count <= 2000));
  assert.equal(r.blocks[1]!.payload, "x");
  assert.equal(r.separators[0]!.text, " ");
  assert.ok(r.receipt);
  assertSound(r, text);
});

test("paragraph boundaries win over line, sentence and word boundaries", () => {
  const text = "First paragraph.\n\nSecond line one.\nSecond line two. More words here";
  const r = run(text, { limit: 40 });
  assert.equal(r.blocks[0]!.payload, "First paragraph.");
  assert.equal(r.separators[0]!.text, "\n\n");
  assertSound(r, text);
});

test("a ZWJ family emoji at the limit is never split and counts differ by unit", () => {
  assert.equal(countCopyUnits(FAMILY, "codepoints"), 7);
  assert.equal(countCopyUnits(FAMILY, "utf16"), 11);
  assert.equal(countCopyUnits(FAMILY, "max(codepoints,utf16)"), 11);

  const text = "a".repeat(1992) + " " + FAMILY; // 2000 code points, 2004 UTF-16 units
  const cp = run(text, { unit: "codepoints" });
  assert.equal(cp.blocks.length, 1);
  assert.equal(cp.blocks[0]!.count, 2000);
  const u16 = run(text, { unit: "utf16" });
  assert.equal(u16.blocks.length, 2);
  assert.equal(u16.blocks[1]!.payload, FAMILY);
  assertSound(u16, text);

  // No spaces at all: the forced cut still lands between clusters.
  const forced = run(FAMILY.repeat(3), { limit: 10 });
  assert.deepEqual(forced.blocks.map((b) => b.payload), [FAMILY, FAMILY, FAMILY]);
  assert.ok(forced.errors.some((e) => e.code === "unsplittable"));
  assert.equal(forced.receipt, null);
  assertSound(forced, FAMILY.repeat(3));
});

test("combining characters stay with their base", () => {
  const text = "é".repeat(3); // 6 code points, 3 clusters
  const r = run(text, { limit: 5 });
  assert.deepEqual(r.blocks.map((b) => b.payload), ["éé", "é"]);
  assertSound(r, text);
  // A space followed by a combining mark is one cluster: no cut there.
  const spaced = "aaaa ́bbb ccc";
  const s = run(spaced, { limit: 10 });
  assert.equal(s.blocks[0]!.payload, "aaaa ́bbb");
  assertSound(s, spaced);
});

test("CRLF: crlf-to-lf rebuilds the LF text, none keeps CRLF and never splits it", () => {
  const text = "line one\r\nline two\r\n\r\nline three";
  const lf = run(text, { normalize: "crlf-to-lf", limit: 10 });
  assert.ok(lf.blocks.every((b) => !b.payload.includes("\r")));
  assertSound(lf, text.replace(/\r\n/g, "\n"));
  const raw = run(text, { normalize: "none", limit: 10 });
  assert.deepEqual(raw.separators.map((s) => s.text), ["\r\n", "\r\n\r\n"]);
  assertSound(raw, text);
  assert.notEqual(lf.receipt, raw.receipt);
});

test("a long URL moves to the next block whole; one longer than the limit is unsplittable", () => {
  const url = "https://example.com/" + "a".repeat(80);
  const text = "See " + url;
  const r = run(text, { limit: 100 });
  assert.deepEqual(r.blocks.map((b) => b.payload), ["See", url]);
  assert.ok(r.receipt);
  const long = run(url, { limit: 50 });
  assert.equal(long.errors[0]!.code, "unsplittable");
  assert.equal(long.receipt, null);
  assertSound(long, url);
});

test("backticks and an embedded fence stay in the payload inside a longer fence", () => {
  const text = "Use `x` here.\n\n```js\nconst a = 1;\n```\nDone.";
  const r = run(text);
  assert.equal(r.blocks[0]!.payload, text);
  assert.equal(r.blocks[0]!.fence, "````");
  assert.ok(r.receipt);
  const chat = renderForChat(r);
  assert.equal(chat, `Block 1/1 · ${text.length} codepoints\n\`\`\`\`\n${text}\n\`\`\`\``);
  assert.equal(run("plain").blocks[0]!.fence, "```");
});

test("empty paragraphs are preserved inside a payload and in separators", () => {
  const text = "One.\n\n\n\nTwo.\n\n\n\nThree.";
  assert.equal(run(text).blocks[0]!.payload, text);
  assert.equal(run(text, { limit: 12 }).blocks[0]!.payload, "One.\n\n\n\nTwo.");
  const r = run(text, { limit: 8 });
  assert.deepEqual(r.separators.map((s) => s.text), ["\n\n\n\n", "\n\n\n\n"]);
  assertSound(r, text);
});

test("a quote prefix fails validation and gives no receipt", () => {
  const r = run("Hello\n> quoted line\nbye");
  assert.deepEqual(r.errors.map((e) => e.code), ["quote_prefix"]);
  assert.equal(r.receipt, null);
  assert.equal(run("a > b is fine").receipt?.startsWith("sha256:"), true);
});

test("a counter or character count inside the payload fails validation", () => {
  for (const text of ["Hi there (1/3)", "Text [123 chars]", "Text [42 Zeichen]", "Block 2/3 · rest"]) {
    const r = run(text);
    assert.deepEqual(r.errors.map((e) => e.code), ["counter_in_payload"], text);
    assert.equal(r.receipt, null);
  }
  assert.ok(run("Mix 1/2 cup of flour.").receipt);
});

test("canonical markers fail even when splitting breaks their syntax", () => {
  for (const [text, limit, code] of [
    ["hello [123 chars]", 10, "counter_in_payload"],
    ["Hello\n> world", 5, "quote_prefix"],
  ] as const) {
    const r = run(text, { limit });
    assert.equal(r.receipt, null);
    assert.equal(r.errors.filter((e) => e.code === code).length, 1);
    assertSound(r, text);
  }
});

test("discord-dm enforces conservative counts despite an explicit unit", () => {
  const text = "😀 ".repeat(1000) + "😀";
  for (const unit of ["codepoints", "utf16"] as const) {
    const r = run(text, { channel: "discord-dm", unit });
    assert.equal(r.unit_applied, "max(codepoints,utf16)");
    assert.ok(r.blocks.every((b) => b.payload.length <= 2000));
    assert.ok(r.receipt);
    assertSound(r, text);
    const implicit = validateCopyBlocks({ text, channel: "discord-dm", normalize: "none" });
    assert.equal(r.receipt, implicit.receipt, "receipt binds the applied unit");
  }
});

test("an empty artifact gives no receipt", () => {
  const r = run("");
  assert.deepEqual(r.errors.map((e) => e.code), ["empty"]);
  assert.equal(r.receipt, null);
});

test("discord-dm defaults: limit 2000, stricter of both counts, named", () => {
  const r = validateCopyBlocks({ text: "hi " + FAMILY, channel: "discord-dm", normalize: "none" });
  assert.equal(r.limit, 2000);
  assert.equal(r.unit_applied, "max(codepoints,utf16)");
  assert.equal(r.blocks[0]!.count, 14);
  assert.throws(() => validateCopyBlocks({ text: "x", channel: "unknown", normalize: "none" }), /no limit/);
});

test("the receipt changes with every bound byte and parameter", () => {
  const base: CopyBlocksInput = {
    text: "Invented message for the test.",
    channel: "test",
    limit: 2000,
    unit: "codepoints",
    normalize: "none",
    rule: { id: "example-rule", revision: "r1" },
    task: { kind: "translate-only", generation: 1 },
  };
  const variants: Partial<CopyBlocksInput>[] = [
    { text: "Invented message for the test!" },
    { channel: "other-dm" },
    { limit: 1999 },
    { unit: "utf16" },
    { normalize: "crlf-to-lf" },
    { rule: { id: "other-rule", revision: "r1" } },
    { rule: { id: "example-rule", revision: "r2" } },
    { rule: undefined },
    { task: { kind: "draft-for-review", generation: 1 } },
    { task: { kind: "translate-only", generation: 2 } },
    { task: undefined },
  ];
  const first = validateCopyBlocks(base).receipt;
  assert.ok(first);
  assert.equal(validateCopyBlocks(base).receipt, first, "deterministic");
  const seen = new Set([first]);
  for (const v of variants) {
    const receipt = validateCopyBlocks({ ...base, ...v }).receipt;
    assert.ok(receipt, JSON.stringify(v));
    assert.ok(!seen.has(receipt), `receipt did not change for ${JSON.stringify(v)}`);
    seen.add(receipt);
  }
  const r = validateCopyBlocks(base);
  assert.equal(
    copyBlocksReceipt({ ...r, rule: base.rule, task: base.task }),
    first,
    "recomputable from the published contract",
  );
});
