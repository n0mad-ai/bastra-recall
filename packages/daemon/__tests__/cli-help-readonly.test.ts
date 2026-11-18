/** #330: choosing help language must not create/migrate settings or business state. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of [
  "missing",
  "legacy",
  "corrupt",
  "database",
  "current",
  "wal",
  "override",
  "tombstone",
  "old-schema",
  "corrupt-db",
]) {
  test(`#330: ${mode} help preserves application state`, () => {
    const script = fileURLToPath(new URL("./fixtures/cli-help-readonly.mjs", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", "tsx", script, mode], {
      env: process.env,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /application state unchanged/);
  });
}
