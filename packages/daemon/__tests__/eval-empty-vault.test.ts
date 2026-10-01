/**
 * scripts/eval.ts against a vault with no eval cases must fail, not report a
 * perfect score. With zero rows the MRR division gave NaN and the "no misses"
 * branch printed "None. Every memory ranked in top-3" — exit 0, clean-pass
 * shaped, for an empty or misconfigured BASTRA_VAULT_PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "eval.ts");

test("eval.ts exits non-zero on an empty vault instead of printing a clean pass", () => {
  const vault = mkdtempSync(join(tmpdir(), "bastra-eval-empty-"));
  try {
    const res = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, BASTRA_VAULT_PATH: vault },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    assert.notEqual(res.status, 0, `an empty vault must fail the run; output:\n${out}`);
    assert.doesNotMatch(out, /Every memory ranked in top-3/);
    assert.doesNotMatch(out, /NaN/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
