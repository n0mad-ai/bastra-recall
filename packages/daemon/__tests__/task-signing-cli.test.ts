import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the source entry point before building so this regression fails on
// the old dispatch, which asks for credentials or signs/enrolls owner keys.
for (const sub of ["keys", "approve", "deny"]) {
  test(`#1428: retired ${sub} command reports chat authorization without credentials or writes`, async () => {
    const root = await mkdtemp(join(tmpdir(), "task-retired-signing-"));
    for (const agent of [false, true]) {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        `import { cmdTasks } from './packages/daemon/src/cli/tasks-cmd.ts'; process.exitCode = await cmdTasks(${JSON.stringify({ sub, positional: [], argv: ["tasks", sub, ...(agent ? ["agent"] : []), "x", "y", "z", "--json"], json: true })});`], {
        env: { ...process.env, BASTRA_TASKS_PATH: join(root, "tasks.json"), BASTRA_TASK_TOKEN: "", BASTRA_TASK_AUTH_PATH: join(root, "auth.json"), BASTRA_TASK_OWNER_CACHE: join(root, "owner.json") },
        stdio: ["ignore", "pipe", "pipe"], timeout: 15000,
      });
      let output = "", errors = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 1, errors);
      const reply = JSON.parse(output || errors);
      assert.equal(reply.code, "retired_command");
      assert.match(reply.hint, /Anweisung im Chat.*Freigabe/);
      assert.deepEqual(await readdir(root), []);
    }
  });
}
test("#1428: retired signing CLI implementation is absent; migration remains separate", async () => {
  await assert.rejects(readFile(new URL("../src/cli/task-approval-cmd.ts", import.meta.url)), { code: "ENOENT" });
  const source = await readFile(new URL("../src/cli/tasks-cmd.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /taskOwnerKeys|taskOwnerSign|task-approval-cmd/);
});
