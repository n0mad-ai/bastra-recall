import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the source CLI with a non-interactive stdin and no task credentials.
for (const agent of [false, true]) {
  test(`#1514: old signing commands are unknown commands in ${agent ? "agent" : "owner"} mode`, async () => {
    const root = await mkdtemp(join(tmpdir(), "task-unknown-command-"));
    for (const sub of ["keys", "approve", "deny", "bogus-command"]) {
      const args = { sub, positional: [], argv: ["tasks", sub, ...(agent ? ["agent"] : []), "x", "y", "z"] };
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import assert from 'node:assert/strict';
           import { cmdTasks } from './packages/daemon/src/cli/tasks-cmd.ts';
           const args = ${JSON.stringify(args)};
           assert.equal(await cmdTasks(args), 1);
           process.exitCode = await cmdTasks({ ...args, json: true, argv: [...args.argv, '--json'] });`,
        ],
        {
          env: {
            ...process.env,
            BASTRA_TASKS_PATH: join(root, "tasks.json"),
            BASTRA_TASK_TOKEN: "",
            BASTRA_TASK_AUTH_PATH: join(root, "auth.json"),
            BASTRA_TASK_OWNER_CACHE: join(root, "owner.json"),
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        }
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 1, sub);
      assert.equal(output, "", sub);
      const [text, json, tail] = errors.split("\n");
      assert.equal(text, `${sub}: Unknown subcommand.`);
      assert.equal(tail, "");
      assert.deepEqual(
        JSON.parse(json),
        {
          error: "Unknown task operation",
          code: "validation",
          reason: "unknown_task_operation",
          retryable: false,
          status: 400,
        },
        sub
      );
      assert.deepEqual(await readdir(root), []);
    }
  });
}
test("#1428: retired signing CLI implementation is absent; migration remains separate", async () => {
  await assert.rejects(readFile(new URL("../src/cli/task-approval-cmd.ts", import.meta.url)), { code: "ENOENT" });
  const source = await readFile(new URL("../src/cli/tasks-cmd.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /taskOwnerKeys|taskOwnerSign|task-approval-cmd/);
});
