/** recall-daily: loads per memory and day from the telemetry event logs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallDaily } from "../src/recall-daily.js";

const NOW = Date.UTC(2026, 10, 12, 15, 0);
const row = (o: Record<string, unknown>) =>
  JSON.stringify({ kind: "load_memory", found: true, session_id: "s", ...o }) + "\n";

test("recallDaily counts found loads per day, skips misses, other kinds and old days", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recall-daily-"));
  try {
    await writeFile(
      join(dir, "events-2026-11-12.jsonl"),
      row({ ts: "2026-11-12T09:00:00Z", id: "a" }) +
        row({ ts: "2026-11-12T10:00:00Z", id: "a" }) +
        row({ ts: "2026-11-12T10:00:00Z", id: "b", found: false }) +
        JSON.stringify({ kind: "recall", ts: "2026-11-12T10:00:00Z", id: "a" }) +
        "\nnot json\n"
    );
    await writeFile(join(dir, "events-2026-11-10.jsonl"), row({ ts: "2026-11-10T23:59:00Z", id: "a" }));
    await writeFile(join(dir, "events-2026-09-01.jsonl"), row({ ts: "2026-09-01T10:00:00Z", id: "a" }));
    const m = await recallDaily(dir, NOW);
    assert.deepEqual(m.get("a"), [
      [0, 2],
      [2, 1],
    ]);
    assert.equal(m.has("b"), false);
    // today's file grows: the cache notices the new size
    await appendFile(join(dir, "events-2026-11-12.jsonl"), row({ ts: "2026-11-12T11:00:00Z", id: "c" }));
    assert.deepEqual((await recallDaily(dir, NOW)).get("c"), [[0, 1]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recallDaily on a missing log dir is empty", async () => {
  assert.equal((await recallDaily(join(tmpdir(), "no-such-recall-daily-dir"), NOW)).size, 0);
});

test("recallDaily excludes eval_run and dimensions measurement markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recall-daily-eval-"));
  try {
    const rows = [
      { id: "eval-marker", eval_run: true },
      { id: "eval-dim", dimensions: { client: "eval" } },
      { id: "replay-dim", dimensions: { client: "replay" } },
      { id: "real", eval_run: false },
      { id: "legacy" },
    ];
    await writeFile(
      join(dir, "events-2026-11-12.jsonl"),
      rows.map((e) => row({ ts: "2026-11-12T09:00:00Z", ...e })).join("")
    );
    assert.deepEqual(
      [...(await recallDaily(dir, NOW))],
      [
        ["real", [[0, 1]]],
        ["legacy", [[0, 1]]],
      ]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
