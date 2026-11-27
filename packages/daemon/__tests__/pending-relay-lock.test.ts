import { readAppRecord, deleteAppRecord, appRecordDatabasePath } from "../src/app-record-store.js";
import test from "node:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink, rm, stat, utimes } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathLockFilePath } from "../src/path-lock.js";
import { settlePendingRelay, takePendingRelay, writePendingFromHook } from "../src/pending-suggestions.js";
import { purgeDrafts } from "../src/draft-store.js";
import { cmdDrafts } from "../src/cli/drafts-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { runStopLane, evaluateHeuristics } from "../src/stop-lane.js";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(work: (path: string, drafts: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "relay-lock-")),
    path = join(dir, "pending.json"),
    drafts = join(dir, "drafts.json");
  const env = {
    BASTRA_PENDING_SUGGESTIONS_PATH: path,
    BASTRA_DRAFTS_PATH: drafts,
    BASTRA_PENDING_RELAY: "1",
    BASTRA_SESSION_HARVEST: "0",
    BASTRA_TELEMETRY: "off",
  };
  const prev = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    await work(path, drafts);
  } finally {
    for (const [k, v] of prev)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
}
test("busy relay reads skip immediately, preserve bytes, and deliver on the next attempt without diagnostics", (t) =>
  fixture(async (path) => {
    const original = JSON.stringify([{ ts: Date.now(), blocks: "Invented retained relay observation" }]);
    await writeFile(path, original);
    await writeFile(pathLockFilePath(path), "held fixture lock");
    const before = (await stat(path)).mtimeMs,
      start = performance.now();
    assert.deepEqual(await takePendingRelay(), { recency: [], trends: [] });
    t.diagnostic(`busy read returned in ${(performance.now() - start).toFixed(1)} ms`);
    assert.ok(performance.now() - start < 100, "busy read must not wait for the five-second lease");
    await delay(100);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mtimeMs, before);
    await unlink(pathLockFilePath(path));
    assert.equal((await takePendingRelay()).recency.length, 1);
  }));
test("a relay reader recovers an old dead local owner but leaves an old live owner alone", () =>
  fixture(async (path) => {
    const now = Date.now();
    await writeFile(path, JSON.stringify([{ ts: now, blocks: "Invented retained relay observation" }]));
    const lock = pathLockFilePath(path);
    const expired = new Date(now - 60_000);
    const liveOwner = { pid: process.pid, host: hostname(), ts: expired.getTime(), token: "live-fixture" };
    await writeFile(lock, JSON.stringify(liveOwner));
    await utimes(lock, expired, expired);
    assert.deepEqual(await takePendingRelay(), { recency: [], trends: [] });
    assert.equal(await readFile(lock, "utf8"), JSON.stringify(liveOwner));

    const deadPid = spawnSync(process.execPath, ["--eval", ""]).pid;
    assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
    await writeFile(lock, JSON.stringify({ ...liveOwner, pid: deadPid, token: "dead-fixture" }));
    await utimes(lock, expired, expired);
    assert.deepEqual((await takePendingRelay()).recency, [{ ts: now, blocks: "Invented retained relay observation" }]);
  }));
test("busy hook writes return immediately and the deferred write persists after unlock without losing old entries", (t) =>
  fixture(async (path) => {
    const original = JSON.stringify([{ ts: Date.now(), blocks: "Invented old relay observation" }]);
    await writeFile(path, original);
    await writeFile(pathLockFilePath(path), "held fixture lock");
    let warnings = "";
    t.mock.method(process.stderr, "write", (s: unknown) => {
      warnings += String(s);
      return true;
    });
    try {
      const start = performance.now();
      await writePendingFromHook("Invented new relay observation");
      assert.ok(performance.now() - start < 100);
      await delay(100);
      assert.equal(await readFile(path, "utf8"), original);
    } finally {
      await unlink(pathLockFilePath(path));
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = JSON.parse(readAppRecord("pending-suggestions", path));
      if (rows.length === 2) break;
      await delay(20);
    }
    const rows = JSON.parse(readAppRecord("pending-suggestions", path));
    assert.deepEqual(
      rows.map((r: { blocks: string }) => r.blocks),
      ["Invented old relay observation", "Invented new relay observation"]
    );
    assert.equal(warnings, "");
  }));
test(
  "purge invalidates a queued writer in another process and a taken delivery",
  { skip: process.platform === "win32" },
  () =>
    fixture(async (path) => {
      await writePendingFromHook("fixture taken before purge");
      const taken = await takePendingRelay();
      assert.equal(taken.recency.length, 1);
      await writeFile(pathLockFilePath(path), "held fixture lock");
      const moduleUrl = new URL("../src/pending-suggestions.ts", import.meta.url).href;
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { writePendingFromHook } from ${JSON.stringify(moduleUrl)};
         await writePendingFromHook("fixture queued before purge");
         process.stdout.write("queued");
         process.kill(process.pid, "SIGSTOP");
         await new Promise((resolve) => setTimeout(resolve, 150));`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const exited = once(child, "exit");
      try {
        const queued = await Promise.race([
          once(child.stdout!, "data"),
          exited.then(() => assert.fail("writer exited before queueing")),
        ]);
        assert.match(String(queued[0]), /queued/);
        await unlink(pathLockFilePath(path));
        await purgeDrafts();
        await settlePendingRelay(taken.recency, [], undefined, taken.generation);
        await writePendingFromHook("fixture queued after purge");
        child.kill("SIGCONT");
        assert.deepEqual(await exited, [0, null]);
        assert.deepEqual(
          (await takePendingRelay()).recency.map((row) => row.blocks),
          ["fixture queued after purge"]
        );
      } finally {
        child.kill("SIGCONT");
        child.kill("SIGTERM");
        await exited;
      }
    })
);

test("a deferred hook write does not keep a short-lived process open", () =>
  fixture(async (path) => {
    await writeFile(pathLockFilePath(path), "held fixture lock");
    const moduleUrl = new URL("../src/pending-suggestions.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { writePendingFromHook } from ${JSON.stringify(moduleUrl)};
         await writePendingFromHook("Invented deferred relay observation");
         console.log("hook returned");`,
      ],
      { timeout: 5000 }
    );
    assert.equal(stdout.trim(), "hook returned");
    assert.equal(await readFile(pathLockFilePath(path), "utf8"), "held fixture lock");
  }));
test("the actual Stop response skips busy relay contention and writes later", () =>
  fixture(async (path) => {
    const turns = [
      { role: "assistant", content: "Which architecture?\n1. Polling\n2. Queue" },
      { role: "user", content: "2" },
    ];
    assert.ok(evaluateHeuristics(turns).length > 0);
    await writeFile(path, "[]");
    await writeFile(pathLockFilePath(path), "held fixture lock");
    const start = performance.now();
    try {
      assert.equal(
        await runStopLane({ hook_event_name: "Stop", cwd: "/tmp", transcript: turns }, "http://127.0.0.1:1"),
        "{}"
      );
      assert.ok(performance.now() - start < 500);
      assert.equal(await readFile(path, "utf8"), "[]");
    } finally {
      await unlink(pathLockFilePath(path));
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (JSON.parse(readAppRecord("pending-suggestions", path)).length) break;
      await delay(20);
    }
    assert.match(readAppRecord("pending-suggestions", path), /architecture-decision/);
  }));
test("draft deletion failure leaves the validated relay unchanged", (t) =>
  fixture(async (path, drafts) => {
    const original = JSON.stringify([{ ts: Date.now(), blocks: "Invented retained relay observation" }]);
    await writeFile(path, original);
    await writeFile(drafts, "draft fixture");
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("INSERT INTO app_records")) {
        const run = statement.run.bind(statement);
        t.mock.method(statement, "run", (...args: unknown[]) => {
          if (args[0] === "drafts" && JSON.parse(String(args[2])).text === null)
            throw Object.assign(new Error("fixture draft deletion denied"), { code: "EACCES" });
          return Reflect.apply(run, statement, args);
        });
      }
      return statement;
    });
    try {
      await assert.rejects(purgeDrafts(), /draft deletion denied/);
      assert.equal(readAppRecord("pending-suggestions", path), original);
      assert.equal(readAppRecord("drafts", drafts), "draft fixture");
    } finally {
      t.mock.restoreAll();
    }
  }));
test("purge accepts an empty relay, keeps it private, and reports an absent relay honestly", () =>
  fixture(async (path, drafts) => {
    await writeFile(path, "");
    await writeFile(drafts, "draft fixture");
    assert.deepEqual(await purgeDrafts(), { pendingRelay: true });
    assert.deepEqual(JSON.parse(readAppRecord("pending-suggestions", path)), []);
    if (process.platform !== "win32") assert.equal((await stat(appRecordDatabasePath(path))).mode & 0o777, 0o600);
    deleteAppRecord("pending-suggestions", path);
    await writeFile(drafts, "draft fixture");
    assert.deepEqual(await purgeDrafts(), { pendingRelay: false });
    await assert.rejects(stat(path), { code: "ENOENT" });
  }));

test("purge reports a relay access error separately from draft-store errors", (t) =>
  fixture(async (path, drafts) => {
    await writeFile(path, "{invalid fixture");
    await writeFile(drafts, "draft fixture");
    let stderr = "";
    t.mock.method(process.stderr, "write", (chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    assert.equal(await cmdDrafts(parseArgs(["drafts", "purge"])), 1);
    assert.match(stderr, /cannot clear pending relay; original preserved/);
    assert.doesNotMatch(stderr, /cannot access local drafts|invalid fixture/);
    assert.equal(await readFile(drafts, "utf8"), "draft fixture");
  }));
