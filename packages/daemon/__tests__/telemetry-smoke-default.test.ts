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
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "telemetry-smoke.ts");
const exec = promisify(execFile);

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

test("concurrent smoke runs use separate temporary log directories and clean them", async () => {
  const roots = [
    mkdtempSync(join(tmpdir(), "bastra-smoke-one-")),
    mkdtempSync(join(tmpdir(), "bastra-smoke-two-")),
  ];
  try {
    const runs = await Promise.all(roots.map((root) =>
      exec(process.execPath, ["--import", "tsx", SCRIPT], {
        timeout: 60_000,
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, HOME: root },
      }),
    ));
    const logDirs = runs.map(({ stderr }, i) => {
      const match = /log-dir: (.+)/.exec(stderr);
      assert.ok(match, `run ${i + 1} did not report its temporary log directory: ${stderr}`);
      return match[1].trim();
    });
    assert.notEqual(logDirs[0], logDirs[1]);
    for (const [i, dir] of logDirs.entries()) {
      assert.ok(dir.startsWith(roots[i] + sep), `run ${i + 1} used ${dir} outside its temp root`);
      assert.equal(existsSync(dir), false, `run ${i + 1} left its log directory behind`);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
