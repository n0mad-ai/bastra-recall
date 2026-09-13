/**
 * Tests for the per-memory usage sidecar (#154): append → read → compact
 * lifecycle, crash recovery of a half-finished compaction, torn-line and
 * corrupt-aggregate tolerance, and the never-throws contract.
 *
 * Run: npx tsx --test packages/daemon/__tests__/usage-sidecar.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordUsage,
  readUsage,
  compactUsage,
  maybeCompactUsage,
  type UsageEvent,
} from "../src/usage-sidecar.js";

const USAGE = join(".bastra", "usage");

async function withVault<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bastra-usage-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function ev(id: string, kind: UsageEvent["kind"], ts: string): UsageEvent {
  return { id, kind, ts };
}

test("record → read: counters and last_*_at aggregate per id", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [
      ev("a", "surfaced", "2026-07-01T10:00:00Z"),
      ev("a", "surfaced", "2026-07-02T10:00:00Z"),
      ev("a", "loaded", "2026-07-02T10:01:00Z"),
      ev("b", "acted_on", "2026-07-03T09:00:00Z"),
    ]);
    const agg = await readUsage(root);
    assert.deepEqual(agg["a"], {
      surfaced: 2,
      loaded: 1,
      acted_on: 0,
      last_surfaced_at: "2026-07-02T10:00:00Z",
      last_loaded_at: "2026-07-02T10:01:00Z",
    });
    assert.equal(agg["b"].acted_on, 1);
  });
});

test("#479 revision-local counters reset on content change without losing lifetime history", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [
      { ...ev("a", "surfaced", "2026-09-01T10:00:00Z"), revision: "rev-a" },
      { ...ev("a", "surfaced", "2026-09-02T10:00:00Z"), revision: "rev-a" },
      { ...ev("a", "loaded", "2026-09-02T10:01:00Z"), revision: "rev-a" },
      { ...ev("a", "surfaced", "2026-09-03T10:00:00Z"), revision: "rev-b" },
      // Crash replay from the older revision: lifetime history counts it, but
      // it must not roll the active revision back.
      { ...ev("a", "surfaced", "2026-09-01T09:00:00Z"), revision: "rev-a" },
    ]);
    const entry = (await readUsage(root)).a;
    assert.deepEqual(
      {
        surfaced: entry.surfaced,
        loaded: entry.loaded,
        revision: entry.revision,
        revision_surfaced: entry.revision_surfaced,
        revision_loaded: entry.revision_loaded,
        revision_seen_at: entry.revision_seen_at,
      },
      {
        surfaced: 4,
        loaded: 1,
        revision: "rev-b",
        revision_surfaced: 1,
        revision_loaded: 0,
        revision_seen_at: "2026-09-03T10:00:00Z",
      },
    );
  });
});

test("compact: events fold into aggregate.json; readUsage identical before/after", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [ev("a", "surfaced", "2026-07-01T10:00:00Z"), ev("a", "acted_on", "2026-07-01T11:00:00Z")]);
    const before = await readUsage(root);
    const folded = await compactUsage(root);
    assert.equal(folded, 2);
    const after = await readUsage(root);
    assert.deepEqual(after, before);
    // events file rotated away, aggregate persisted
    await assert.rejects(stat(join(root, USAGE, "events.jsonl")));
    const persisted = JSON.parse(await readFile(join(root, USAGE, "aggregate.json"), "utf8"));
    assert.equal(persisted["a"].surfaced, 1);
  });
});

test("compact is cumulative across runs and new events keep counting", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [ev("a", "loaded", "2026-07-01T10:00:00Z")]);
    await compactUsage(root);
    await recordUsage(root, [ev("a", "loaded", "2026-07-02T10:00:00Z")]);
    await compactUsage(root);
    const agg = await readUsage(root);
    assert.equal(agg["a"].loaded, 2);
    assert.equal(agg["a"].last_loaded_at, "2026-07-02T10:00:00Z");
  });
});

test("crash recovery: a rotated-but-unfolded file is counted by readUsage and folded by the next compact", async () => {
  await withVault(async (root) => {
    // Simulate a run that crashed after rotation: events sit in the
    // compacting file, nothing in aggregate yet.
    await mkdir(join(root, USAGE), { recursive: true });
    await writeFile(
      join(root, USAGE, "events.compacting.jsonl"),
      JSON.stringify(ev("a", "surfaced", "2026-07-01T10:00:00Z")) + "\n",
      "utf8",
    );
    // New events arrived after the crash.
    await recordUsage(root, [ev("a", "surfaced", "2026-07-02T10:00:00Z")]);

    const live = await readUsage(root);
    assert.equal(live["a"].surfaced, 2, "readUsage must count the crashed leftover");

    const folded = await compactUsage(root);
    assert.equal(folded, 2, "recovery folds leftover AND fresh events");
    const agg = JSON.parse(await readFile(join(root, USAGE, "aggregate.json"), "utf8"));
    assert.equal(agg["a"].surfaced, 2);
    await assert.rejects(stat(join(root, USAGE, "events.compacting.jsonl")));
  });
});

test("torn last line (crash mid-append) is skipped, valid lines still count", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [ev("a", "surfaced", "2026-07-01T10:00:00Z")]);
    await appendFile(join(root, USAGE, "events.jsonl"), '{"id":"a","ki', "utf8");
    const agg = await readUsage(root);
    assert.equal(agg["a"].surfaced, 1);
    assert.equal(await compactUsage(root), 1);
  });
});

test("corrupt aggregate.json degrades to events-only instead of failing", async () => {
  await withVault(async (root) => {
    await mkdir(join(root, USAGE), { recursive: true });
    await writeFile(join(root, USAGE, "aggregate.json"), "{not json", "utf8");
    await recordUsage(root, [ev("a", "loaded", "2026-07-01T10:00:00Z")]);
    const agg = await readUsage(root);
    assert.equal(agg["a"].loaded, 1);
    // compaction replaces the corrupt file with a clean one
    await compactUsage(root);
    const persisted = JSON.parse(await readFile(join(root, USAGE, "aggregate.json"), "utf8"));
    assert.equal(persisted["a"].loaded, 1);
  });
});

test("replayed older event never regresses last_*_at (max, not last-write)", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [
      ev("a", "acted_on", "2026-07-02T10:00:00Z"),
      ev("a", "acted_on", "2026-07-01T10:00:00Z"),
    ]);
    const agg = await readUsage(root);
    assert.equal(agg["a"].acted_on, 2);
    assert.equal(agg["a"].last_acted_on_at, "2026-07-02T10:00:00Z");
  });
});

test("unknown kinds and empty ids are ignored, not counted and not fatal", async () => {
  await withVault(async (root) => {
    await mkdir(join(root, USAGE), { recursive: true });
    await appendFile(
      join(root, USAGE, "events.jsonl"),
      '{"id":"a","kind":"emitted","ts":"2026-07-01T10:00:00Z"}\n{"id":"","kind":"loaded","ts":"2026-07-01T10:00:00Z"}\n',
      "utf8",
    );
    const agg = await readUsage(root);
    assert.deepEqual(agg, {});
  });
});

test("never-throws contract: vaultRoot pointing at a file", async () => {
  await withVault(async (root) => {
    const notADir = join(root, "file.txt");
    await writeFile(notADir, "x", "utf8");
    await recordUsage(notADir, [ev("a", "surfaced", "2026-07-01T10:00:00Z")]); // must not throw
    assert.deepEqual(await readUsage(notADir), {});
    assert.equal(await compactUsage(notADir), 0);
    await maybeCompactUsage(notADir); // must not throw
  });
});

test("maybeCompact: below threshold is a no-op, events file stays", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [ev("a", "surfaced", "2026-07-01T10:00:00Z")]);
    await maybeCompactUsage(root);
    await stat(join(root, USAGE, "events.jsonl")); // still there
  });
});
