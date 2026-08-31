/**
 * Raw control bytes in source files (#416).
 *
 * A NUL as a field separator in a hash input is the right idea — it cannot occur
 * in a path or an id. Written as a RAW BYTE in the source instead of the `\0`
 * escape it is still the right idea and a reviewability defect: git classifies
 * the file as binary and renders `Bin 11013 -> 11387 bytes` instead of a diff,
 * and a plain `grep -rn` sweep skips the file entirely. Both were observed on
 * `goldset-harvest.ts` before this test existed.
 *
 * The escape produces the identical string at runtime, so nothing that was
 * hashed with a raw byte needs re-hashing.
 *
 * Run: npx tsx --test packages/eval/__tests__/source-hygiene.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bytes that make a file "binary" to git and grep. TAB (9), LF (10) and CR (13)
 * are ordinary text and stay allowed; ESC (27) is excluded here because a test
 * about terminal output may legitimately carry one, and this suite only guards
 * the eval sources.
 */
const isForbidden = (b: number): boolean => (b < 9 || b === 11 || b === 12 || (b >= 14 && b < 32)) && b !== 27;

const srcDir = join(import.meta.dirname, "..", "src");

test("no eval source file carries a raw control byte (#416)", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const bytes = readFileSync(join(srcDir, name));
    const found = [...new Set([...bytes].filter(isForbidden))].sort((a, b) => a - b);
    if (found.length) offenders.push(`${name}: ${found.map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "write the escape (\\0, \\x01) instead of the raw byte — same string at runtime, reviewable diff",
  );
});

test("the escape is the same separator the raw byte was (#416)", () => {
  // The point of the fix: `origin_ref_hash` and every other hash input built
  // with these separators keeps its value, so nothing needs re-hashing.
  assert.equal("a\0b".length, 3);
  assert.equal("a\0b".charCodeAt(1), 0);
  assert.equal("a\x01b".charCodeAt(1), 1);
});
