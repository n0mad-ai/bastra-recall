/**
 * Log retention (#23).
 *
 * The interesting test here is not "old files get deleted" — it is that the
 * retention window can never dip below what the curator mines (30 days). These
 * logs are input to reflex promotion, so a too-eager cleanup would look like
 * housekeeping and behave like silent recall degradation.
 *
 * Runner: `tsx --test __tests__/log-retention.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneEventLogs,
  resolveRetentionDays,
  RETENTION_FLOOR_DAYS,
  RETENTION_DEFAULT_DAYS,
} from "../src/log-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-22T12:00:00Z");

function dayFile(daysAgo: number): string {
  const d = new Date(NOW - daysAgo * DAY_MS);
  return `events-${d.toISOString().slice(0, 10)}.jsonl`;
}

async function withLogDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-retention-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("retention: drops logs past the window, keeps everything inside it", async () => {
  await withLogDir(async (dir) => {
    for (const age of [0, 5, 89, 95, 400]) {
      await writeFile(join(dir, dayFile(age)), '{"ts":"x"}\n', "utf8");
    }
    const r = await pruneEventLogs({ logDir: dir, now: NOW });

    assert.equal(r.keptDays, RETENTION_DEFAULT_DAYS);
    assert.deepEqual(r.removed.sort(), [dayFile(400), dayFile(95)].sort());

    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [dayFile(0), dayFile(5), dayFile(89)].sort());
  });
});

test("retention: replay logs (#702) age out on the same window as event logs", async () => {
  await withLogDir(async (dir) => {
    const replayFile = (age: number): string => dayFile(age).replace(/^events-/, "replay-");
    for (const age of [5, 95]) await writeFile(join(dir, replayFile(age)), '{"ts":"x"}\n', "utf8");
    const r = await pruneEventLogs({ logDir: dir, now: NOW });
    assert.deepEqual(r.removed, [replayFile(95)]);
    assert.deepEqual(await readdir(dir), [replayFile(5)]);
  });
});

test("retention: the curator's 30-day window is a floor, not a suggestion", () => {
  // Someone trying to be tidy sets 7 days. The curator needs 30 — so 30 wins.
  assert.equal(resolveRetentionDays("7"), RETENTION_FLOOR_DAYS);
  assert.equal(resolveRetentionDays("1"), RETENTION_FLOOR_DAYS);
  // Above the floor the operator is in charge.
  assert.equal(resolveRetentionDays("365"), 365);
  // Garbage and "0" fall back to the default — "0" must never read as
  // "keep forever", which is exactly the state this feature ends.
  assert.equal(resolveRetentionDays("0"), RETENTION_DEFAULT_DAYS);
  assert.equal(resolveRetentionDays("nonsense"), RETENTION_DEFAULT_DAYS);
  assert.equal(resolveRetentionDays(undefined), RETENTION_DEFAULT_DAYS);
});

test("retention: a 30-day setting still leaves the curator a full window", async () => {
  await withLogDir(async (dir) => {
    for (const age of [0, 15, 29]) {
      await writeFile(join(dir, dayFile(age)), '{"ts":"x"}\n', "utf8");
    }
    const r = await pruneEventLogs({ logDir: dir, days: RETENTION_FLOOR_DAYS, now: NOW });
    assert.deepEqual(r.removed, [], "nothing inside the curator window may be removed");
    assert.equal((await readdir(dir)).length, 3);
  });
});

test("retention: touches only dated event logs", async () => {
  await withLogDir(async (dir) => {
    await writeFile(join(dir, dayFile(400)), "x\n", "utf8");
    // Neighbours in the same directory that are emphatically not ours.
    await writeFile(join(dir, "join-state.json"), "{}", "utf8");
    await writeFile(join(dir, "gemma4-watch.log"), "x\n", "utf8");
    await writeFile(join(dir, "events-not-a-date.jsonl"), "x\n", "utf8");

    const r = await pruneEventLogs({ logDir: dir, now: NOW });

    assert.deepEqual(r.removed, [dayFile(400)]);
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ["events-not-a-date.jsonl", "gemma4-watch.log", "join-state.json"]);
  });
});

test("retention: dryRun reports without deleting", async () => {
  await withLogDir(async (dir) => {
    await writeFile(join(dir, dayFile(400)), "0123456789\n", "utf8");
    const r = await pruneEventLogs({ logDir: dir, now: NOW, dryRun: true });
    assert.deepEqual(r.removed, [dayFile(400)]);
    assert.ok(r.freedBytes > 0);
    assert.equal((await readdir(dir)).length, 1, "dry run must leave the file in place");
  });
});

test("retention: a missing log dir is not an error", async () => {
  const r = await pruneEventLogs({ logDir: join(tmpdir(), "bastra-does-not-exist-9e7f"), now: NOW });
  assert.deepEqual(r.removed, []);
  assert.equal(r.freedBytes, 0);
});
