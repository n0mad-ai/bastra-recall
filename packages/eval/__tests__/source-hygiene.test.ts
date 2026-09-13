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
 * WHY THIS NOW WALKS EVERY PACKAGE. The guard used to cover `packages/eval/src`
 * alone, and the lesson stopped at that package boundary: on 2026-09-10 the same
 * defect was found in `daemon/src/telemetry.ts` (the #485 session key) and
 * `daemon/src/host-profile.ts` (the fingerprint separators) — five raw bytes in
 * code written long after #416. `grep -n "class Telemetry" telemetry.ts` printed
 * nothing while the class sat on line 171, which cost a review two false trails.
 * A rule that only guards the package it was born in does not carry a lesson.
 *
 * AND WHY IT RECURSES. `readdirSync` without `recursive` reads one level. That
 * was invisible while eval had a flat `src/`, but it would have skipped 53 of
 * the daemon's 181 sources and 40 of statusline's 43 — a guard that reports
 * green over files it never opened is worse than no guard.
 *
 * It stays here, next to the defect it was written for, rather than moving to a
 * repo-wide home: the package list below is the whole coupling, and moving the
 * file would cost its history for no change in behaviour.
 *
 * Run: npx tsx --test packages/eval/__tests__/source-hygiene.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bytes that make a file "binary" to git and grep. TAB (9), LF (10) and CR (13)
 * are ordinary text and stay allowed; ESC (27) is excluded because a source
 * about terminal output may legitimately carry one — statusline renders ANSI,
 * and turning its themes red would be a false positive, not a find.
 */
const isForbidden = (b: number): boolean => (b < 9 || b === 11 || b === 12 || (b >= 14 && b < 32)) && b !== 27;

const packagesDir = join(import.meta.dirname, "..", "..");

/** Every published source tree. A new package belongs in this list. */
const GUARDED = ["core", "daemon", "eval", "statusline"] as const;

test("no source file in any package carries a raw control byte (#416)", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const pkg of GUARDED) {
    const srcDir = join(packagesDir, pkg, "src");
    for (const rel of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
      if (!rel.endsWith(".ts")) continue;
      scanned++;
      const bytes = readFileSync(join(srcDir, rel));
      const found = [...new Set([...bytes].filter(isForbidden))].sort((a, b) => a - b);
      if (found.length) {
        offenders.push(`${pkg}/src/${rel}: ${found.map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ")}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "write the escape (\\0, \\x01) instead of the raw byte — same string at runtime, reviewable diff",
  );
  // Without this the sweep could pass by reading nothing at all — a wrong base
  // path, a renamed `src/`, a `recursive` option that stops working. The number
  // is a floor, not the current count, so adding or removing files is free.
  assert.ok(scanned > 250, `the sweep must actually open the sources, opened ${scanned}`);
});

test("the escape is the same separator the raw byte was (#416)", () => {
  // The point of the fix: `origin_ref_hash` and every other hash input built
  // with these separators keeps its value, so nothing needs re-hashing.
  assert.equal("a\0b".length, 3);
  assert.equal("a\0b".charCodeAt(1), 0);
  assert.equal("a\x01b".charCodeAt(1), 1);
});
