/**
 * #1691: the non-waiting lock path (`tryWithPathLock`, used by draft-store hook
 * feedback) must write and judge strict leases exactly like the waiting path.
 *
 * Before the fix it ignored `strictLocal`: its lease carried no boot identity,
 * so after a restart a recycled pid made the dead holder look alive and stalled
 * every later draft write; and it could never take over a dead holder's lease.
 * A live holder must still never lose its lease, on either path.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/path-lock-try-strict.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withPathLock, tryWithPathLock, pathLockFilePath, PathLockUnavailableError } from "../src/path-lock.js";
import { DRAFT_STORE_LOCK } from "../src/draft-store.js";

const DEAD_PID = 2147483647;
const OTHER_BOOT = "00000000-0000-4000-8000-000000000000";
const hasBoot = process.platform === "darwin" || process.platform === "linux";

function quietStderr(t: { after: (fn: () => void) => void }) {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
}

async function tempDir(t: { after: (fn: () => Promise<void>) => void }, name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `bastra-1691-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The lease body the waiting strict path writes for this process. */
async function blockingBody(dir: string): Promise<Record<string, unknown>> {
  const state = join(dir, "blocking-probe.json");
  let body: Record<string, unknown> = {};
  await withPathLock(
    state,
    async () => {
      body = JSON.parse(await readFile(pathLockFilePath(state), "utf8")) as Record<string, unknown>;
    },
    { strictLocal: true }
  );
  return body;
}

type Outcome = { ran: boolean; untouched: boolean };

/** Plants `body` as a held lease, then runs one writer on the chosen path. */
async function attempt(dir: string, name: string, body: Record<string, unknown>, waiting: boolean): Promise<Outcome> {
  const state = join(dir, `${name}-${waiting ? "wait" : "try"}.json`);
  const raw = JSON.stringify({ token: `held-${name}`, ts: Date.now(), ...body });
  await writeFile(pathLockFilePath(state), raw, { mode: 0o600 });
  let ran = false;
  const fn = async () => {
    ran = true;
  };
  if (waiting) {
    try {
      await withPathLock(state, fn, DRAFT_STORE_LOCK);
    } catch (error) {
      assert.ok(error instanceof PathLockUnavailableError, `${name}: ${String(error)}`);
    }
  } else await tryWithPathLock(state, fn, DRAFT_STORE_LOCK);
  const after = await readFile(pathLockFilePath(state), "utf8").catch(() => null);
  return { ran, untouched: after === raw };
}

test("#1691: the non-waiting strict lease records the same boot identity as the waiting one", async (t) => {
  const dir = await tempDir(t, "boot");
  const expected = await blockingBody(dir);
  const state = join(dir, "try.json");
  let body: Record<string, unknown> = {};
  const result = await tryWithPathLock(
    state,
    async () => {
      body = JSON.parse(await readFile(pathLockFilePath(state), "utf8")) as Record<string, unknown>;
      return "held";
    },
    DRAFT_STORE_LOCK
  );
  assert.equal(result, "held");
  assert.equal(body.pid, process.pid);
  assert.equal(body.host, hostname());
  assert.equal(body.boot, expected.boot);
  if (hasBoot) assert.match(String(body.boot), /^[0-9a-f-]{36}$/);
  assert.equal(existsSync(pathLockFilePath(state)), false, "the lease is released afterwards");
});

test(
  "#1691: waiting and non-waiting paths take over exactly the same dead holders and keep every live one",
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, "compare");
    quietStderr(t);
    const host = hostname();
    const boot = String((await blockingBody(dir)).boot ?? "unknown");
    // [name, planted lease, taken over?]
    const cases: [string, Record<string, unknown>, boolean][] = [
      // process.pid stands in for an unrelated process that got the pid after a restart.
      ["earlier-boot", { pid: process.pid, host, boot: OTHER_BOOT }, hasBoot],
      ["dead-pid", { pid: DEAD_PID, host }, true],
      ["dead-pid-same-boot", { pid: DEAD_PID, host, boot }, true],
      // The rightful live holder, with and without a boot field.
      ["live-same-boot", { pid: process.pid, host, boot }, false],
      ["live-no-boot", { pid: process.pid, host }, false],
      // A damaged boot field proves nothing; the live pid decides.
      ["live-damaged-boot", { pid: process.pid, host, boot: "not-a-boot-id" }, false],
      ["live-number-boot", { pid: process.pid, host, boot: 42 }, false],
      // Another machine sharing the file is never judged dead from here.
      ["remote", { pid: DEAD_PID, host: "other-host", boot: OTHER_BOOT }, false],
      // An unparsable lease has no owner to prove dead.
      ["damaged-pid", { pid: "x", host }, false],
    ];
    const results = await Promise.all(
      cases.flatMap(([name, body]) => [attempt(dir, name, body, true), attempt(dir, name, body, false)])
    );
    cases.forEach(([name, , takenOver], index) => {
      const [waiting, trying] = [results[index * 2], results[index * 2 + 1]];
      assert.deepEqual(trying, waiting, `${name}: both paths decide alike`);
      assert.equal(trying.ran, takenOver, `${name}: takeover`);
      assert.equal(trying.untouched, !takenOver, `${name}: the holder's lease stays as it was`);
    });
  }
);

test("#1691: a draft-store hook write is not stalled by a lease from an earlier boot", async (t) => {
  if (!hasBoot) return t.skip("no boot identity here");
  const dir = await tempDir(t, "drafts");
  const previous = process.env.BASTRA_DRAFTS_PATH;
  const path = join(dir, "drafts.json");
  process.env.BASTRA_DRAFTS_PATH = path;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH;
    else process.env.BASTRA_DRAFTS_PATH = previous;
  });
  const { transactDrafts } = await import("../src/draft-store.js");
  // The pid is alive again (here: this process), but in an earlier boot it was the writer.
  await writeFile(
    pathLockFilePath(path),
    JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: "old", boot: OTHER_BOOT })
  );
  assert.equal(await transactDrafts(async () => "written", Date.now(), true), "written");
  assert.equal(existsSync(pathLockFilePath(path)), false);
});

test("#1691: concurrent non-waiting takeovers of one dead lease never overlap", { timeout: 60_000 }, async (t) => {
  const dir = await tempDir(t, "race");
  const state = join(dir, "state.json");
  await writeFile(
    pathLockFilePath(state),
    JSON.stringify({ pid: DEAD_PID, host: hostname(), ts: Date.now(), token: "dead" }),
    { mode: 0o600 }
  );
  const worker = join(dir, "worker.mjs");
  const source = new URL("../src/path-lock.ts", import.meta.url).href;
  await writeFile(
    worker,
    `import fs from "node:fs";
    const [state, role] = process.argv.slice(2);
    const { tryWithPathLock } = await import(${JSON.stringify(source)});
    fs.writeFileSync(state + ".ready-" + role, "");
    while (!fs.existsSync(state + ".go")) await new Promise((r) => setTimeout(r, 1));
    const result = await tryWithPathLock(state, async () => {
      try { fs.writeFileSync(state + ".inside", role, { flag: "wx" }); }
      catch { fs.writeFileSync(state + ".overlap-" + role, ""); }
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(state + ".inside", { force: true });
      return "won";
    }, { crossProcess: true, strictLocal: true });
    fs.writeFileSync(state + ".result-" + role, String(result ?? "skipped"));
    `
  );
  const roles = ["a", "b", "c", "d", "e", "f"];
  const children = roles.map((role) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, state, role], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    return new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${role}: ${stderr}`))));
    });
  });
  const end = Date.now() + 30_000;
  while (!roles.every((role) => existsSync(`${state}.ready-${role}`))) {
    assert.ok(Date.now() < end, "workers did not start");
    await delay(5);
  }
  await writeFile(`${state}.go`, "");
  await Promise.all(children);
  const names = await readdir(dir);
  assert.deepEqual(
    names.filter((name) => name.includes(".overlap-")),
    [],
    "two writers held the lease at once"
  );
  const results = await Promise.all(roles.map((role) => readFile(`${state}.result-${role}`, "utf8")));
  assert.ok(results.includes("won"), `the dead lease was taken over: ${results.join(",")}`);
  assert.deepEqual(
    names.filter((name) => /\.lock(?:\.|$)/.test(name)),
    [],
    "no lease or reclaim marker is left behind"
  );
});
