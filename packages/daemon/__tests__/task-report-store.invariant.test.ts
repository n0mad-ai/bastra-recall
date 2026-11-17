// #1611: the report store tolerates fields a later version adds. A daemon
// that does not know such a field still reads the store, keeps the field on
// every write and never hands it out. Before, a strict schema refused the
// whole store as soon as one report carried a newer field.
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readAppRecord, writeAppRecord } from "../src/app-record-store.js";

const ID = "00000000-0000-4000-8000-000000000001";
const NOTE = "00000000-0000-4000-8000-000000000002";

test("INV-TASK-09: fields a later version added survive every write and never leave through an answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-report-store-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 5_000 };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "claude", domains: ["personal"], role: "agent" });
  const call = (op: string, input: unknown) =>
    callTaskCrud({ ...ctx, ownerUi: true }, `Bearer ${agent.token}`, op as any, input) as Promise<any>;
  const storePath = join(root, "task-reports.json");
  const later = {
    version: 1,
    shelf: { from: "a later version" },
    reports: [
      {
        id: ID,
        title: "Bericht",
        body: "- Preise prüfen\n",
        origin: { client: "codex", device: "mac" },
        actor: "claude",
        owner_domains: ["personal"],
        created_at: 1_000,
        tags: ["later"],
        notes: [
          {
            id: NOTE,
            anchor: { kind: "item", index: 1, excerpt: "Preise prüfen", path: [0, 1] },
            text: "Nochmal",
            actor: "claude",
            created_at: 2_000,
            state: "open",
            handed_at: 3_000,
            colour: "amber",
          },
        ],
      },
    ],
  };
  writeAppRecord("task-reports", storePath, JSON.stringify(later));

  const listed = await call("task_report_list", {});
  assert.equal(listed.reports.length, 1, "the store is read, not refused");
  assert.deepEqual(listed.reports[0].origin, { client: "codex" });
  assert.equal(listed.reports[0].tags, undefined);
  const read = await call("task_report_read", { id: ID });
  assert.equal(read.notes[0].colour, undefined, "an unknown field is never handed out");
  assert.deepEqual(read.notes[0].anchor, { kind: "item", index: 1, excerpt: "Preise prüfen" });

  await call("task_report_mark", { id: ID, read: true });
  await call("task_report_note_edit", { id: ID, note_id: NOTE, text: "Anders" });
  const stored = JSON.parse(readAppRecord("task-reports", storePath));
  assert.deepEqual(stored.shelf, later.shelf);
  const r = stored.reports[0];
  assert.deepEqual(r.tags, ["later"]);
  assert.equal(r.origin.device, "mac");
  assert.equal(r.read_at, 5_000);
  assert.equal(r.notes[0].colour, "amber");
  assert.deepEqual(r.notes[0].anchor.path, [0, 1]);
  assert.equal(r.notes[0].text, "Anders");

  await call("task_report_delete", { id: ID });
  const back = await call("task_report_restore", { id: ID });
  assert.equal(back.tags, undefined);
  const restored = JSON.parse(readAppRecord("task-reports", storePath)).reports[0];
  assert.deepEqual(restored.tags, ["later"], "undo brings the unknown fields back too");
});
