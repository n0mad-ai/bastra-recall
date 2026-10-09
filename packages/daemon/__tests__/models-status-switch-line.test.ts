/**
 * `bastra models` prints the command for the model it recommends; the heavier
 * alternative gets a line of its own.
 *
 * Second counter-review of the model-recommendation notice (PR #1118, on
 * 1fc5ad07); its reproduction kept as a test. No Ollama, only invented files.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/models-status-switch-line.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { cmdModels } from "../src/cli/models-cmd.js";
import { quiet, withDir } from "./fixtures/model-decision-helpers.js";
// ── P2: the command under `recommended:` is for the recommended model ────────

test("bastra models: `to switch` names the recommended model; the alternative has its own line", async () => {
  await withDir(async (_dir, path) => {
    const status = async (ramGB: number) => (await quiet(() => cmdModels({ sub: "status", settingsPath: path, deps: { recommendation: null, ramGB } }))).out.trimEnd().split("\n");
    const at24 = await status(24);
    assert.ok(at24.includes("recommended: tev1:4b  [enhanced]"));
    assert.deepEqual(at24.slice(-2), ["to switch: bastra models set tev1:4b", "alternative: bastra models set gemma4:12b"]);
    const at16 = await status(16);
    assert.equal(at16[at16.length - 1], "to switch: bastra models set tev1:4b");
    assert.ok(!at16.some((l) => l.startsWith("alternative:")));
    const at32 = await status(32);
    assert.equal(at32[at32.length - 1], "to switch: bastra models set gemma4:12b");
    // Already on the alternative: it is not offered as one.
    await writeFile(path, JSON.stringify({ generation: { model: "gemma4:12b" } }));
    const onAlt = await status(24);
    assert.equal(onAlt[onAlt.length - 1], "to switch: bastra models set tev1:4b");
    // Already on the recommended model: no command at all.
    await writeFile(path, JSON.stringify({ generation: { model: "tev1:4b" } }));
    assert.ok(!(await status(24)).some((l) => l.startsWith("to switch") || l.startsWith("alternative")));
  });
});
