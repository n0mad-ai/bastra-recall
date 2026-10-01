/**
 * #525 — `.github/workflows/formula-drift.yml` runs `tools/check-tap-drift.mjs`
 * daily. The script exits 1 for real drift and 2 when the live formula cannot
 * be fetched, but the step ran it bare, so a raw.githubusercontent.com hiccup
 * and a real divergence were the same red X — and a red that cries wolf is one
 * everybody learns to ignore.
 *
 * The step's `run:` block is lifted out of the workflow and executed with a
 * stub check script, for each event and exit code:
 *   - drift (1) stays red on every event
 *   - a failed fetch (2) is a ::warning:: and passes on the daily schedule
 *   - a failed fetch on push / workflow_dispatch still fails, for the person
 *     who triggered the run
 *
 * Runner: node --test tools/__tests__/formula-drift-workflow.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/formula-drift.yml", import.meta.url));

/** The `run:` text of the step that compares the live formula — literal block or one line. */
async function driftStepScript() {
  const lines = (await readFile(WORKFLOW, "utf8")).split("\n");
  const at = lines.findIndex((l) => l.includes("name: Compare the live tap formula"));
  assert.ok(at >= 0, "the compare step is gone from formula-drift.yml");
  const run = lines.findIndex((l, i) => i > at && /^\s*run:/.test(l));
  assert.ok(run >= 0, "the compare step has no run:");
  const head = lines[run].replace(/^\s*run:\s*/, "");
  if (head && head !== "|") return head;
  const indent = /^\s*/.exec(lines[run + 1])[0].length;
  const body = [];
  for (let i = run + 1; i < lines.length && (lines[i].trim() === "" || /^\s*/.exec(lines[i])[0].length >= indent); i++) {
    body.push(lines[i].slice(indent));
  }
  return body.join("\n");
}

async function runStep(event, exitCode) {
  const script = (await driftStepScript()).replaceAll("${{ github.event_name }}", event);
  const dir = await mkdtemp(join(tmpdir(), "formula-drift-"));
  try {
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "tools", "check-tap-drift.mjs"), `process.exit(${exitCode});\n`);
    const res = spawnSync("bash", ["-eo", "pipefail", "-c", script], { cwd: dir, encoding: "utf8" });
    return { status: res.status, stdout: res.stdout };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a failed fetch on the daily schedule is a warning annotation, not a red run", async () => {
  const res = await runStep("schedule", 2);
  assert.equal(res.status, 0, "an unreachable live formula failed the scheduled run");
  assert.match(res.stdout, /^::warning /m);
});

test("real drift stays red on every event", async () => {
  for (const event of ["schedule", "push", "workflow_dispatch"]) {
    assert.equal((await runStep(event, 1)).status, 1, `drift did not fail a ${event} run`);
  }
});

test("a failed fetch still fails a run somebody triggered", async () => {
  for (const event of ["push", "workflow_dispatch"]) {
    assert.equal((await runStep(event, 2)).status, 2, `an unfetchable formula passed a ${event} run`);
  }
});

test("no drift passes", async () => {
  assert.equal((await runStep("schedule", 0)).status, 0);
});
