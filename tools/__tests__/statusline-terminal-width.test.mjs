/**
 * codePointWidth zero-widthed only Latin-range combining blocks, so Hebrew
 * points, Arabic tashkil and Devanagari non-spacing marks each counted as a
 * column and visibleLength overstated such strings, misaligning TUI padding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  codePointWidth,
  visibleLength,
} from "../../packages/statusline/src/utils/terminal.ts";

test("Hebrew niqqud, Arabic tashkil and Devanagari marks take no column", () => {
  for (const cp of [0x05b0, 0x05bc, 0x064e, 0x0651, 0x0670, 0x0941, 0x094d]) {
    assert.equal(codePointWidth(cp), 0, `U+${cp.toString(16)}`);
  }
});

test("visibleLength counts base letters only", () => {
  // shalom with niqqud: shin+kamatz, lamed, vav+holam, mem-sofit
  assert.equal(visibleLength("שָׁלוֹם"), 4);
  // Arabic "muhammad" with fatha/shadda: 4 letters
  assert.equal(visibleLength("مُحَمّد"), 4);
  // Devanagari ka + virama (non-spacing) + ta
  assert.equal(visibleLength("क्त"), 2);
});

test("spacing marks and base letters still take a column", () => {
  assert.equal(codePointWidth(0x05d0), 1);
  assert.equal(codePointWidth(0x0627), 1);
  assert.equal(codePointWidth(0x0915), 1);
  assert.equal(visibleLength("abc"), 3);
});
