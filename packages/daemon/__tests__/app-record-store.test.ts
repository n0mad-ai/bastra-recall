import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile, rm, stat } from "node:fs/promises";
import fs, { type Mode, type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readAppRecord,
  writeAppRecord,
  deleteAppRecord,
  appRecordDatabasePath,
  exportAppRecord,
} from "../src/app-record-store.js";

test("legacy local state migrates byte-for-byte once, with retained original and database backup", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "floors.json");
  const original =
    '[{"memory_id":"existing-floor","condition":"decision","reason":"keep","floored_at":"2026-11-08T10:00:00.000Z","last_affirmed":"2026-11-08T10:00:00.000Z"}]\n';
  await writeFile(path, original);
  assert.equal(readAppRecord("floors", path), original);
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), original);
  await assert.rejects(stat(path), { code: "ENOENT" });
  const files = await readdir(dir);
  const backups = files.filter((name) => name.startsWith("recall.db.import-") && name.endsWith(".db"));
  assert.equal(backups.length, 1);
  assert.equal(readAppRecord("floors", path), original);
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.startsWith("recall.db.import-")),
    backups
  );
  writeAppRecord("floors", path, "[]");
  assert.equal(readAppRecord("floors", path), "[]");
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), original, "rollback input remains unchanged after new writes");
  const rollback = join(dir, "floors.rollback.json");
  exportAppRecord("floors", path, rollback);
  assert.equal(await readFile(rollback, "utf8"), "[]", "rollback export retains new writes");
  assert.throws(() => exportAppRecord("floors", path, rollback), { code: "EEXIST" });
  assert.equal(appRecordDatabasePath(path), join(dir, "recall.db"));
});

test("a local database override cannot authorize migration from a sync folder or a source symlink", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-sources-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_DB_PATH;
  process.env.BASTRA_DB_PATH = join(dir, "local", "recall.db");
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_DB_PATH;
    else process.env.BASTRA_DB_PATH = previous;
  });
  const syncDir = join(dir, "CloudStorage", "fixture-vault");
  await mkdir(syncDir, { recursive: true });
  const source = join(syncDir, "floors.json");
  await writeFile(source, "[]");
  assert.throws(() => readAppRecord("floors", source), /sync or vault source/);
  assert.equal(await readFile(source, "utf8"), "[]");
  if (process.platform !== "win32") {
    const link = join(dir, "alias.json");
    await symlink(source, link);
    assert.throws(() => readAppRecord("floors", link), /sync or vault source|source symlink/);
    assert.equal(await readFile(source, "utf8"), "[]");
  }
});

test("committed import resumes archive rename after interruption; deletion never resurrects old rows", async (t) => {
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

test("explicit store paths and store kinds cannot collide", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-isolate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, "first.json"),
    second = join(dir, "second.json");
  writeAppRecord("skills", first, "one");
  writeAppRecord("skills", second, "two");
  writeAppRecord("floors", first, "three");
  assert.equal(readAppRecord("skills", first), "one");
  assert.equal(readAppRecord("skills", second), "two");
  assert.equal(readAppRecord("floors", first), "three");
});

test("#1579: losing the archive rename to a concurrent reader still returns the committed state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  await writeFile(path, '{"mode":"auto"}');
  assert.equal(readAppRecord("settings", path), '{"mode":"auto"}');
  // The row is committed; the legacy file is back as in the post-commit window.
  await rename(`${path}.pre-db`, path);
  // Another process completes the same rename between this reader's presence
  // check and its own chmod/rename.
  const real = fs.chmodSync;
  fs.chmodSync = ((file: PathLike, mode: Mode) => {
    if (String(file) === path) fs.renameSync(path, `${path}.pre-db`);
    return real(file, mode);
  }) as typeof fs.chmodSync;
  syncBuiltinESMExports();
  try {
    assert.equal(readAppRecord("settings", path), '{"mode":"auto"}');
  } finally {
    fs.chmodSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), '{"mode":"auto"}');
});

test("#1588: a database without the record of an already archived file is not read as 'no state'", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-record-elsewhere-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_DB_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_DB_PATH;
    else process.env.BASTRA_DB_PATH = previous;
  });
  const path = join(dir, "cli-settings.json");
  await writeFile(path, '{"update":{"mode":"auto"}}');
  process.env.BASTRA_DB_PATH = join(dir, "alt", "recall.db");
  assert.equal(readAppRecord("settings", path), '{"update":{"mode":"auto"}}');
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), '{"update":{"mode":"auto"}}');
  // A process without the override opens a different database.
  delete process.env.BASTRA_DB_PATH;
  const elsewhere = (error: NodeJS.ErrnoException) =>
    error.code === "ESTATEELSEWHERE" && error.message.includes(`${path}.pre-db`) && error.message.includes("recall.db");
  assert.throws(() => readAppRecord("settings", path), elsewhere);
  assert.throws(() => writeAppRecord("settings", path, '{"update":{"mode":"off"}}'), elsewhere);
  assert.throws(() => deleteAppRecord("settings", path), elsewhere);
  process.env.BASTRA_DB_PATH = join(dir, "alt", "recall.db");
  assert.equal(readAppRecord("settings", path), '{"update":{"mode":"auto"}}', "the real state is unchanged");
  // Without any archived original, a store that never existed stays absent.
  delete process.env.BASTRA_DB_PATH;
  assert.throws(() => readAppRecord("settings", join(dir, "never.json")), { code: "ENOENT" });
});
