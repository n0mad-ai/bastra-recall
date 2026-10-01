/**
 * commit-pool --synthetic must exercise the hash comparison it demonstrates
 *. The LEAK row flips naive→FAIL through the recipient re-score alone;
 * shipped hash and author hash both came from the same in-memory log, so the
 * comparison could never fail and deleting it left the output byte-identical.
 * The TAMPERED row ships a fine bridge under the hash of a different log: only
 * the comparison can fail it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "commit-pool.ts");

const cells = (out: string, label: string): string[] => {
  const line = out.split("\n").find((l) => l.startsWith(label));
  assert.ok(line, `row ${label} missing from:\n${out}`);
  return line.split("|").slice(1, 3).map((c) => c.trim());
};

test("--synthetic has a TAMPERED control the hash check alone must fail", () => {
  const res = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--synthetic"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(cells(res.stdout, "positive"), ["PASS", "PASS"]);
  assert.deepEqual(cells(res.stdout, "LEAK"), ["PASS", "FAIL"]);
  assert.deepEqual(cells(res.stdout, "TAMPERED"), ["PASS", "FAIL"]);
});
