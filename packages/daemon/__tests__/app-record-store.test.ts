import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAppRecord, writeAppRecord, deleteAppRecord, appRecordDatabasePath, exportAppRecord } from "../src/app-record-store.js";

test("legacy local state migrates byte-for-byte once, with retained original and database backup", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "floors.json");
  const original = '[{"memory_id":"existing-floor","condition":"decision","reason":"keep","floored_at":"2026-11-08T10:00:00.000Z","last_affirmed":"2026-11-08T10:00:00.000Z"}]\n';
  await writeFile(path, original);
  assert.equal(readAppRecord("floors", path), original);
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), original);
  await assert.rejects(stat(path), { code: "ENOENT" });
  const files = await readdir(dir);
  const backups = files.filter(name => name.startsWith("recall.db.import-") && name.endsWith(".db"));
  assert.equal(backups.length, 1);
  assert.equal(readAppRecord("floors", path), original);
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith("recall.db.import-")), backups);
  writeAppRecord("floors", path, "[]");
  assert.equal(readAppRecord("floors", path), "[]");
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), original, "rollback input remains unchanged after new writes");
  const rollback = join(dir, "floors.rollback.json");
  exportAppRecord("floors", path, rollback);
  assert.equal(await readFile(rollback, "utf8"), "[]", "rollback export retains new writes");
  assert.throws(() => exportAppRecord("floors", path, rollback), { code: "EEXIST" });
  assert.equal(appRecordDatabasePath(path), join(dir, "recall.db"));
});

test("a local database override cannot authorize migration from a sync folder or a source symlink", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-sources-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_DB_PATH;
  process.env.BASTRA_DB_PATH = join(dir, "local", "recall.db");
  t.after(() => { if (previous === undefined) delete process.env.BASTRA_DB_PATH; else process.env.BASTRA_DB_PATH = previous; });
  const syncDir = join(dir, "CloudStorage", "fixture-vault");
  await mkdir(syncDir, { recursive: true });
  const source = join(syncDir, "floors.json"); await writeFile(source, "[]");
  assert.throws(() => readAppRecord("floors", source), /sync or vault source/);
  assert.equal(await readFile(source, "utf8"), "[]");
  if (process.platform !== "win32") {
    const link = join(dir, "alias.json"); await symlink(source, link);
    assert.throws(() => readAppRecord("floors", link), /sync or vault source|source symlink/);
    assert.equal(await readFile(source, "utf8"), "[]");
  }
});

test("committed import resumes archive rename after interruption; deletion never resurrects old rows", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pending.json");
  await writeFile(path, "[]");
  assert.equal(readAppRecord("pending", path), "[]");
  // Simulate the post-commit/pre-rename window by restoring the retained input.
  await writeFile(path, "[]");
  assert.equal(readAppRecord("pending", path), "[]");
  await assert.rejects(stat(path), { code: "ENOENT" });
  deleteAppRecord("pending", path);
  assert.throws(() => readAppRecord("pending", path), { code: "ENOENT" });
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), "[]");
});

test("explicit store paths and store kinds cannot collide", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-isolate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, "first.json"), second = join(dir, "second.json");
  writeAppRecord("skills", first, "one");
  writeAppRecord("skills", second, "two");
  writeAppRecord("floors", first, "three");
  assert.equal(readAppRecord("skills", first), "one");
  assert.equal(readAppRecord("skills", second), "two");
  assert.equal(readAppRecord("floors", first), "three");
});
