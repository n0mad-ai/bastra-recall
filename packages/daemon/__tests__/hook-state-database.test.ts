import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, readdir, rename } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "../src/app-database.js";
import * as ss from "../src/session-state.js";
import { FAST_LANE_P90_TARGET_MS } from "../src/hook-budgets.js";
import { isThrottled, markThrottle } from "../src/bash-fail-lane.js";

afterEach(() => { delete process.env.BASTRA_HOOK_STATE_DIR; });
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hook-state-db-"));
  process.env.BASTRA_HOOK_STATE_DIR = dir;
  return dir;
}
function child(source: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--import", "./scripts/test-env.mjs", "--input-type=module", "-e",
    `import * as ss from ${JSON.stringify(new URL("../src/session-state.ts", import.meta.url).href)}; ${source}`],
  { env: process.env, encoding: "utf8", timeout: 10_000 });
}

test("#1339 stage2: old hook state and load markers migrate once with originals preserved", async () => {
  const dir = await root();
  const raw = '{"shown":{"memo":{"count":2,"at":100}},"sources":{"todo":{"streak":2,"at":100,"ids":["memo"],"skipped":0}},"constants":{"kernel":"revision"},"pendingMustLoad":[{"id":"memo","block":"must-load","at":100}],"touched":{"/repo":{"a.ts":{"at":100,"last":100,"hits":[],"unplaced":false,"truncated":false}}}}';
  await writeFile(join(dir, "legacy.json"), raw);
  await writeFile(join(dir, "other-session.json"), raw);
  await writeFile(join(dir, "loaded-memo.touch"), "100");
  await writeFile(join(dir, "loaded-other.touch"), "100");
  const sharedDb = openAppDatabase({ path: join(dir, "recall.db") });
  try {
    sharedDb.transaction(() => {
      const insert = sharedDb.sqlite.prepare("INSERT INTO app_records(namespace,key,value) VALUES('other-store',?,?)");
      for (let i = 0; i < 100; i++) insert.run(String(i), JSON.stringify({ fixture: i }));
    });
  } finally { sharedDb.close(); }
  const markerAt = (await stat(join(dir, "loaded-memo.touch"))).mtimeMs;
  const state = await ss.loadSessionState("legacy");
  assert.equal((await ss.loadSessionState("other-session")).shown.memo.count, 2);
  assert.equal(state.shown.memo.count, 2);
  assert.equal(state.sources?.todo.streak, 2);
  assert.equal(state.touched?.get("/repo")?.get("a.ts")?.at, 100);
  assert.equal(await ss.getLoadedMarkerMtime("memo"), markerAt);
  assert.equal(await readFile(join(dir, "legacy.json.pre-sqlite"), "utf8"), raw);
  await assert.rejects(stat(join(dir, "legacy.json")), { code: "ENOENT" });
  await ss.mutateSessionState("legacy", value => ss.bumpShown(value, "new", 200));
  assert.equal((await ss.loadSessionState("legacy")).shown.new.count, 1);
  assert.equal(await readFile(join(dir, "legacy.json.pre-sqlite"), "utf8"), raw);
  const db = openAppDatabase({ path: join(dir, "recall.db") });
  try {
    assert.ok(db.sqlite.prepare("SELECT value FROM app_records WHERE namespace LIKE 'hook-session:%' AND key='legacy'").get());
    assert.equal(Number(db.sqlite.prepare("SELECT COUNT(*) AS n FROM app_records WHERE namespace='other-store'").get()?.n), 100);
    assert.ok((await readdir(`${db.path}.backups`)).some(name => name.startsWith("before-hook-state-")));
  } finally { db.close(); }
});

test("#1339 stage2: warm reads stay in memory and state snapshots do not alias", async () => {
  const dir = await root();
  await ss.saveSessionState("warm", { shown: { memo: { count: 1, at: 100 } } });
  // No JSON file is created by new state writes.
  await assert.rejects(stat(join(dir, "warm.json")), { code: "ENOENT" });
  const first = await ss.loadSessionState("warm");
  (first as ss.SessionState).shown.memo.count = 999;
  assert.equal((await ss.loadSessionState("warm")).shown.memo.count, 1);
  const probe = openAppDatabase({ path: join(dir, "recall.db") });
  const prototype = Object.getPrototypeOf(probe.sqlite) as { prepare: typeof probe.sqlite.prepare };
  const originals = { prepare: prototype.prepare, readFile: fs.readFile, readdir: fs.readdir, stat: fs.stat };
  const forbidden = () => { throw new Error("Warm reads must not access disk or SQLite"); };
  prototype.prepare = forbidden;
  fs.readFile = forbidden; fs.readdir = forbidden; fs.stat = forbidden;
  try {
    assert.equal((await ss.loadSessionState("warm")).shown.memo.count, 1);
    assert.equal(await ss.getLoadedMarkerMtime("missing"), null);
  } finally {
    prototype.prepare = originals.prepare;
    fs.readFile = originals.readFile; fs.readdir = originals.readdir; fs.stat = originals.stat;
    probe.close();
  }
  const timings: number[] = [];
  for (let i = 0; i < 120; i++) {
    const start = performance.now();
    await ss.mutateSessionState("warm", value => ss.bumpShown(value, `m${i}`));
    await ss.loadSessionState("warm");
    await ss.touchLoadedMarker(`m${i}`);
    await ss.getLoadedMarkerMtime(`m${i}`);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  assert.ok(timings[108] < FAST_LANE_P90_TARGET_MS, `state p90 ${timings[108]} exceeds fast lane ${FAST_LANE_P90_TARGET_MS}ms`);
});

test("#1339 stage2: restart finishes post-commit renames and never reimports stale state", async () => {
  const dir = await root();
  await writeFile(join(dir, "restart.json"), '{"shown":{"old":{"count":1,"at":1}}}');
  child('await ss.loadSessionState("restart"); await ss.mutateSessionState("restart",s=>ss.bumpShown(s,"new",2));');
  const backups = await readdir(join(dir, "recall.db.backups"));
  // Simulate a process that committed the import but died before renaming.
  await rename(join(dir, "restart.json.pre-sqlite"), join(dir, "restart.json"));
  const resultPath = join(dir, "restart-result.txt");
  child(`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(await ss.loadSessionState("restart")));`);
  const state = JSON.parse(await readFile(resultPath, "utf8")) as ss.SessionState;
  assert.equal(state.shown.new.count, 1, "the stale original never overwrites a committed update");
  await assert.rejects(stat(join(dir, "restart.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(dir, "recall.db.backups")), backups, "second hydrate does not rerun the data migration");
});

test("#1339 stage2: a foreign process update survives a local mutation and stale-cache cleanup", async () => {
  const dir = await root();
  await ss.saveSessionState("shared", { shown: { first: { count: 1, at: 1 } } });
  child('await ss.mutateSessionState("shared",s=>ss.bumpShown(s,"foreign",2));');
  await ss.persistDraftHintClaims("shared", ["draft"], dir);
  await ss.mutateSessionState("shared", state => ss.bumpShown(state, "local", 3));
  const updated = await ss.loadSessionState("shared");
  assert.ok(updated.shown.foreign);
  assert.ok(updated.shown.local);
  assert.deepEqual(updated.draftShown, ["draft"]);
  // The cached timestamp can be old while another process refreshed the row.
  const db = openAppDatabase({ path: join(dir, "recall.db") });
  try {
    const row = db.sqlite.prepare("SELECT namespace,key,value FROM app_records WHERE namespace LIKE 'hook-session:%' AND key='shared'").get()!;
    const persisted = JSON.parse(String(row.value)) as { raw: string; at: number };
    persisted.at = Date.now() + 60_000;
    db.sqlite.prepare("UPDATE app_records SET value=? WHERE namespace=? AND key=?").run(JSON.stringify(persisted), String(row.namespace), String(row.key));
    await ss.cleanupOldStates(-1);
    assert.ok(db.sqlite.prepare("SELECT 1 FROM app_records WHERE namespace=? AND key=?").get(String(row.namespace), String(row.key)), "fresh foreign state cannot be deleted using a stale cache timestamp");
  } finally { db.close(); }
});

test("#1339 stage2: a contended DB writer never blocks a hook claim", async () => {
  const dir = await root();
  await ss.saveSessionState("busy", { shown: {} });
  const writer = openAppDatabase({ path: join(dir, "recall.db") });
  writer.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const start = performance.now();
    const saved = await ss.mutateSessionState("busy", state => ss.bumpShown(state, "denied"), { noQueue: true, deadline: Date.now() + 100 });
    assert.equal(saved, false);
    assert.ok(performance.now() - start < 100, "no SQLite busy wait on hook path");
    assert.equal((await ss.loadSessionState("busy")).shown.denied, undefined, "failed claim never reaches cache");
  } finally { writer.sqlite.exec("ROLLBACK"); writer.close(); }
});

test("#1339 stage2: Bash failure throttle migrates with its original 30s timestamp", async () => {
  const dir = await root();
  await writeFile(join(dir, "fail-throttle-legacy.ts"), String(Date.now()));
  assert.equal(await isThrottled("legacy"), true);
  assert.ok(await stat(join(dir, "fail-throttle-legacy.ts.pre-sqlite")));
  assert.equal(await isThrottled("fresh"), false);
  await markThrottle("fresh");
  assert.equal(await isThrottled("fresh"), true);
  await assert.rejects(stat(join(dir, "fail-throttle-fresh.ts")), { code: "ENOENT" });
});
