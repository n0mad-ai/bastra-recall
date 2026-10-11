import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskInputFile } from "../src/cli/tasks-cmd.js";
import { taskFailure } from "../src/task-transport.js";
test("missing, malformed and oversized CLI input are clear validation failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-cli-input-"));
  const bad = join(root, "bad.json"); const big = join(root, "big.json");
  await writeFile(bad, "{bad"); await writeFile(big, "a".repeat(256 * 1024 + 1));
  for (const path of [join(root, "absent.json"), bad, big, root]) await assert.rejects(readTaskInputFile(path), (error: any) => {
    assert.equal(error.code, "validation"); assert.match(error.message, /readable.*valid JSON/);
    assert.equal(taskFailure(error).status, 400); return true;
  });
});
