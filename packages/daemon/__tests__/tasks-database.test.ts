import "./tasks-opt-in.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskStore, decodeTaskStore, transactTaskStore } from "../src/task-store.js";
import { readAppRecord, exportAppRecord } from "../src/app-record-store.js";

// Frozen schema-v3 snapshot from the pre-database contract at e1191a2a.
// Synthetic hashes/signatures are inert; no owner credential is included.
test("today's pre-DB tasks migrate unchanged with backup, recurrence, journal and receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-db-migration-"));
  const path = join(root, "tasks.json");
  const raw = await readFile(new URL("./fixtures/tasks-pre-db-e1191a2a.json", import.meta.url), "utf8");
  const expected = decodeTaskStore(raw);
  const previous = JSON.stringify({ ...expected, revision: 16 });
  await writeFile(path, raw); await writeFile(`${path}.backup`, previous);
  assert.deepEqual(await readTaskStore(path), expected);
  assert.equal(await readFile(`${path}.pre-db`, "utf8"), raw);
  assert.equal(await readFile(`${path}.backup.pre-db`, "utf8"), previous);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const names = await readdir(root);
  assert.deepEqual(await readTaskStore(path), expected);
  assert.deepEqual(await readdir(root), names, "second read creates no migration artifacts");
  const changed = await transactTaskStore(path, expected, store => { store.controls.muted = true; });
  assert.equal(changed.revision, 18); assert.equal(changed.tasks[0].revision, 3);
  assert.equal(changed.tasks[0].generation, 1); assert.deepEqual(changed.receipts, expected.receipts);
  assert.equal(JSON.parse(readAppRecord("tasks", `${path}.backup`)).revision, 17);
  const exported = join(root, "rollback.json"); exportAppRecord("tasks", path, exported);
  assert.deepEqual(decodeTaskStore(await readFile(exported, "utf8")), changed);
});
