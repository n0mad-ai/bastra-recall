import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A case file with zero paraphrased cases must not report a lift
 * number at all: `finalize()`'s `run.total || 1` turns 0 queries into a
 * clean "+0.0 pp" and exit 0, which reads as "no measurable lift" instead of
 * "nothing was measured" (e.g. a bad --cases/--vault pointed at nothing).
 * Revert-check: on unfixed marginal-lift.ts this test fails because the CLI
 * exits 0 and prints "+0.0 pp" instead of refusing to report.
 */

const EVAL_DIR = resolve(import.meta.dirname, "..");
const SCRIPT = join(EVAL_DIR, "src", "marginal-lift.ts");

test("marginal-lift: zero paraphrased queries refuses to report a lift number", () => {
  const dir = mkdtempSync(join(tmpdir(), "marginal-lift-empty-"));
  const casesPath = join(dir, "cases.json");
  writeFileSync(casesPath, JSON.stringify({ paraphrased: [], anti: [] }));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--cases", casesPath], {
      cwd: EVAL_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.notEqual(result.status, 0, "zero-query run must not exit 0");
    assert.doesNotMatch(result.stdout, /pp\*\*/, "must not print a lift percentage for zero queries");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
