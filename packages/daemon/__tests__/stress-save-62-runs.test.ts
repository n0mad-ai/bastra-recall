/**
 * scripts/stress-save-62.mjs must refuse a RUNS value that makes its run loop
 * iterate zero times. `Number("0")` and `Number("abc")` (0 / NaN) used to
 * exit 0 having exercised no saves and checked nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "stress-save-62.mjs");

for (const runs of ["0", "abc", "-3", "1.5"]) {
  test(`RUNS=${runs} fails up front instead of checking nothing`, () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, RUNS: runs },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    assert.notEqual(res.status, 0, `output:\n${out}`);
    assert.match(out, /RUNS must be a positive integer/);
  });
}
