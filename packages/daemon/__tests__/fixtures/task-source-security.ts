/** Subprocess probe: a broken FIFO reader must not wedge the test runner. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, realpath, mkdir, writeFile, stat, unlink, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../../src/task-auth.js";
import { callTaskCrud } from "../../src/task-service.js";
import { observeTaskSources, taskValueHash } from "../../src/task-events.js";
import { boundedTaskRead } from "../../src/task-freshness.js";
import { openTaskSourceFile } from "../../src/task-source-file.js";
import { readTaskStore } from "../../src/task-store.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "task-source-security-")));
const work = join(root, "work"); await mkdir(work);
const parent = join(work, "parent"); await mkdir(parent);
const target = join(parent, "note.txt");
const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000 };
const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
const auth = `Bearer ${owner.token}`;
await callTaskCrud(ctx, auth, "task_source_register", { id: "file", kind: "file", producer_actor: "task-source-reader", owner_domains: ["personal"], sensitivity: "private", max_age_ms: 10000, enabled: true, root: work, path: "parent/note.txt" });
await callTaskCrud(ctx, auth, "task_create", { idempotency_key: "probe", original_request: "Watch local fixture", goal: "Watch local fixture", resolution_condition: "Owner review", schedule: { kind: "event", source_id: "file", predicate: "content-version", expected: taskValueHash("inside") }, timezone: "UTC", scope: { kind: "personal", name: "probe" }, owner_domains: ["personal"], arm: true });

if (process.argv[2] === "fifo") {
  execFileSync("mkfifo", [target]);
  for (let i = 0; i < 5; i++) {
    await observeTaskSources(ctx);
    const s = await readTaskStore(ctx.path);
    assert.equal(s.tasks[0].last_failure?.code, "source_unavailable");
    assert.equal(s.events.length, 0);
    await assert.rejects(boundedTaskRead(target, 1024), /regular file/);
  }
  assert.ok((await stat(work)).isDirectory());
  await unlink(target); await writeFile(target, "inside");
  await observeTaskSources(ctx);
  assert.equal((await readTaskStore(ctx.path)).events.length, 1);
} else {
  await writeFile(target, "inside");
  await observeTaskSources(ctx); // require a successful baseline, not vacuous rejection
  assert.equal((await readTaskStore(ctx.path)).events.length, 1);
  const outside = join(root, "outside"); await mkdir(outside);
  await writeFile(join(outside, "note.txt"), "outside-private-content");
  const saved = join(work, "saved");
  // Deterministic parent replacement after the canonical containment check.
  assert.equal(await realpath(target), target);
  await rename(parent, saved); await symlink(outside, parent, "dir");
  await assert.rejects(openTaskSourceFile(target));
  await assert.rejects(boundedTaskRead(target, 1024));
  await unlink(parent); await rename(saved, parent);

  const switcher = spawn(process.execPath, ["--input-type=module", "-e", `
    import {renameSync,symlinkSync,unlinkSync} from 'node:fs';
    const [parent,saved,outside]=process.argv.slice(1);
    process.stdout.write('ready\\n');
    const until=Date.now()+3000;let swaps=0;
    while(Date.now()<until){renameSync(parent,saved);symlinkSync(outside,parent,'dir');unlinkSync(parent);renameSync(saved,parent);swaps++;}
    process.stdout.write(String(swaps));
  `, parent, saved, outside], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(switcher, "exit"); let output = "", errors = "";
  switcher.stdout.on("data", b => { output += b; });
  switcher.stderr.on("data", b => { errors += b; });
  let observations = 0;
  try {
    await once(switcher.stdout, "data");
    while (switcher.exitCode === null) {
      await observeTaskSources(ctx); observations++;
      const s = await readTaskStore(ctx.path);
      assert.ok(s.events.every(e => e.value !== taskValueHash("outside-private-content")));
      // The same bounded reader used for evidence/Memory/prepare/execute.
      try { if (await realpath(target) === target) assert.equal(await boundedTaskRead(target, 1024), "inside"); }
      catch (e) { if (e instanceof assert.AssertionError) throw e; }
    }
    const [code] = await exit; assert.equal(code, 0, errors);
    assert.ok(Number(output.split("\n")[1]) > 0);
    assert.ok(observations >= 5, `only ${observations} observations`);
    const final = await readTaskStore(ctx.path);
    assert.equal(final.events.length, 1);
    assert.equal(final.events[0].value, taskValueHash("inside"));
  } finally { if (switcher.exitCode === null) { switcher.kill("SIGKILL"); await exit; } }
}
process.stdout.write("probe passed\n");
