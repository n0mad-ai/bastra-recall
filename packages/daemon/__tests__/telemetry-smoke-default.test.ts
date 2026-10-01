/**
 * scripts/telemetry-smoke.ts asserts "telemetry should be enabled by default"
 *. That only means something if the script has NOT set
 * BASTRA_TELEMETRY itself first — it used to assign "on" and then check the
 * value it had just set, which cannot notice the default flipping to off.
 *
 * The smoke is run with a preload that reports every write to the telemetry
 * switch, and with the switch set to "off" in the parent env: a script that
 * tests the default must clear it, never assign it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "telemetry-smoke.ts");

test("telemetry-smoke never assigns the telemetry switch before asserting the default", () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-telsmoke-"));
  try {
    const preload = join(dir, "watch-env.mjs");
    writeFileSync(
      preload,
      `process.env = new Proxy(process.env, {
  set(t, k, v) {
    // Only a write that CHANGES the parent's "off" counts (loaders may re-write the inherited value).
    if ((k === "BASTRA_TELEMETRY" || k === "NEXUS_TELEMETRY") && v !== "off") console.error("ENV-SET " + String(k) + "=" + v);
    t[k] = v;
    return true;
  },
});\n`,
    );
    const res = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, SCRIPT], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, BASTRA_TELEMETRY: "off", NEXUS_TELEMETRY: "off", HOME: dir },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    assert.equal(res.status, 0, out);
    assert.doesNotMatch(out, /ENV-SET/, "the smoke must test the default, not a value it set itself");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
