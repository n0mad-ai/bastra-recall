/** #1637: cold hook reads must not initialize or migrate application state.
 * Each child isolates all paths before importing production modules. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["warm", "cold", "wal", "missing", "legacy", "corrupt", "corrupt-db", "corrupt-legacy"]) {
  test(`#1637: ${mode} SubagentStart preserves application state and full context`, (t) => {
    const fixture = fileURLToPath(new URL("./fixtures/subagent-start-state.mjs", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", "tsx", fixture, mode], {
      env: process.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /application state unchanged/);
    t.diagnostic(child.stdout.trim());
  });
}
