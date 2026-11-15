/**
 * Tests für den decay-decoupled Sample Floor (#160): die Measurement-Uhr
 * `last_sampled_at` im Usage-Sidecar und der harte Coverage-Bound, der aus ihr
 * folgt. Deckt ab: Fold ohne Counter-Effekt, Überleben von Compaction und
 * Post-Rotation-Merge, Abwärtskompatibilität mit Aggregaten ohne das Feld, und
 * dass der Bound unabhängig von Salience/Engagement greift.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/sample-floor.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordUsage,
  readUsage,
  compactUsage,
  computeHeat,
  computeReach,
  isSampleDue,
  dueForSampling,
  sampleRotThresholdMs,
  MEASUREMENT_KIND,
  type UsageAggregate,
  type UsageEvent,
} from "../src/usage-sidecar.js";

const USAGE = join(".bastra", "usage");
const DAY = 86_400_000;

async function withVault<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bastra-sample-floor-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function ev(id: string, kind: UsageEvent["kind"], ts: string): UsageEvent {
  return { id, kind, ts };
}

// ─── the clock: fold, compaction, rotation-merge ─────────────────────────────

test("a sampled event stamps last_sampled_at and touches no engagement counter", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [ev("a", MEASUREMENT_KIND, "2026-07-01T10:00:00Z")]);
    const agg = await readUsage(root);
    assert.deepEqual(agg["a"], {
      surfaced: 0,
      loaded: 0,
      acted_on: 0,
      last_sampled_at: "2026-07-01T10:00:00Z",
    });
    // Measuring must not read as demand anywhere downstream.
    assert.deepEqual(computeHeat(agg), {});
    assert.deepEqual(computeReach(agg)["a"], { loaded: 0, acted_on: 0, weight: 0, last_at: null });
  });
});

test("last_sampled_at survives compaction and readUsage is identical before/after", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [
      ev("a", "surfaced", "2026-07-01T10:00:00Z"),
      ev("a", MEASUREMENT_KIND, "2026-07-01T11:00:00Z"),
    ]);
    const before = await readUsage(root);
    assert.equal(await compactUsage(root), 2, "the sampled event is a folded event like any other");
    const after = await readUsage(root);
    assert.deepEqual(after, before);
    const persisted = JSON.parse(await readFile(join(root, USAGE, "aggregate.json"), "utf8"));
    assert.equal(persisted["a"].last_sampled_at, "2026-07-01T11:00:00Z");
    assert.equal(persisted["a"].surfaced, 1);
  });
});

test("compaction is cumulative for the measurement clock: a later probe advances the stamp", async () => {
  await withVault(async (root) => {
    await recordUsage(root, [ev("a", MEASUREMENT_KIND, "2026-07-01T10:00:00Z")]);
    await compactUsage(root);
    await recordUsage(root, [ev("a", MEASUREMENT_KIND, "2026-08-01T10:00:00Z")]);
    await compactUsage(root);
    assert.equal((await readUsage(root))["a"].last_sampled_at, "2026-08-01T10:00:00Z");
  });
});

test("a replayed older sampled event never regresses the stamp (max, not last-write)", async () => {
  await withVault(async (root) => {
    // The post-rotation merge may replay lines out of order; a regressed
    // measurement clock would re-open a bound that was already cleared.
    await recordUsage(root, [
      ev("a", MEASUREMENT_KIND, "2026-07-02T10:00:00Z"),
      ev("a", MEASUREMENT_KIND, "2026-07-01T10:00:00Z"),
    ]);
    assert.equal((await readUsage(root))["a"].last_sampled_at, "2026-07-02T10:00:00Z");
  });
});

test("crash recovery: a sampled event in a rotated-but-unfolded file is counted and folded", async () => {
  await withVault(async (root) => {
    await mkdir(join(root, USAGE), { recursive: true });
    await writeFile(
      join(root, USAGE, "events.compacting.jsonl"),
      JSON.stringify(ev("a", MEASUREMENT_KIND, "2026-07-01T10:00:00Z")) + "\n",
      "utf8"
    );
    assert.equal((await readUsage(root))["a"].last_sampled_at, "2026-07-01T10:00:00Z");
    await compactUsage(root);
    const agg = JSON.parse(await readFile(join(root, USAGE, "aggregate.json"), "utf8"));
    assert.equal(agg["a"].last_sampled_at, "2026-07-01T10:00:00Z");
  });
});

// ─── backwards compatibility ─────────────────────────────────────────────────

test("an aggregate written before the field existed still reads, and reads as due", async () => {
  await withVault(async (root) => {
    await mkdir(join(root, USAGE), { recursive: true });
    await writeFile(
      join(root, USAGE, "aggregate.json"),
      JSON.stringify({ old: { surfaced: 12, loaded: 4, acted_on: 2, last_surfaced_at: "2026-07-01T10:00:00Z" } }),
      "utf8"
    );
    const agg = await readUsage(root);
    assert.equal(agg["old"].surfaced, 12);
    assert.equal(agg["old"].last_sampled_at, undefined, "absence is preserved, not backfilled");
    assert.equal(isSampleDue(agg["old"], Date.parse("2026-07-01T10:00:01Z")), true, "never measured = due");
    // …and one probe clears it without disturbing the counters.
    await recordUsage(root, [ev("old", MEASUREMENT_KIND, "2026-07-02T10:00:00Z")]);
    const after = await readUsage(root);
    assert.equal(after["old"].surfaced, 12);
    assert.equal(isSampleDue(after["old"], Date.parse("2026-07-03T10:00:00Z")), false);
  });
});

test("an entry that has never been sampled is due; a garbled stamp is due too", () => {
  const now = Date.parse("2026-08-01T00:00:00Z");
  assert.equal(isSampleDue(undefined, now), true, "no entry at all = never measured");
  assert.equal(isSampleDue({ surfaced: 0, loaded: 0, acted_on: 0 }, now), true);
  assert.equal(isSampleDue({ surfaced: 0, loaded: 0, acted_on: 0, last_sampled_at: "" }, now), true);
  assert.equal(isSampleDue({ surfaced: 0, loaded: 0, acted_on: 0, last_sampled_at: "nonsense" }, now), true);
});

// ─── the coverage bound ──────────────────────────────────────────────────────

test("the bound is decoupled from engagement: heavy use does not exempt, zero use does not condemn", () => {
  const now = Date.parse("2026-08-01T00:00:00Z");
  const threshold = 30 * DAY;
  const usage: UsageAggregate = {
    // The head: reached constantly, but not measured since June.
    hot: {
      surfaced: 400,
      loaded: 200,
      acted_on: 90,
      last_acted_on_at: "2026-07-31T23:00:00Z",
      last_sampled_at: "2026-06-01T00:00:00Z",
    },
    // The tail: one bad early impression, nothing since — but measured today.
    cold: { surfaced: 1, loaded: 0, acted_on: 0, last_sampled_at: "2026-07-30T00:00:00Z" },
  };
  assert.equal(isSampleDue(usage["hot"], now, threshold), true, "engagement does not buy exemption");
  assert.equal(isSampleDue(usage["cold"], now, threshold), false, "a fresh measurement holds, however cold");
  assert.deepEqual(dueForSampling(usage, Object.keys(usage), now, threshold), ["hot"]);
});

test("the low-salience tail enters the sample even with no sidecar entry at all", () => {
  const now = Date.parse("2026-08-01T00:00:00Z");
  const threshold = 30 * DAY;
  // `never` was demoted early and never surfaced again, so it has no entry —
  // exactly the memory a salience-weighted sample can never draw.
  const usage: UsageAggregate = {
    fresh: { surfaced: 9, loaded: 3, acted_on: 1, last_sampled_at: "2026-07-25T00:00:00Z" },
  };
  assert.deepEqual(dueForSampling(usage, ["fresh"], now, threshold), [], "aggregate keys alone see nothing");
  assert.deepEqual(
    dueForSampling(usage, ["fresh", "never"], now, threshold),
    ["never"],
    "passing the vault's id set is what makes the bound cover the tail"
  );
});

test("due list is ordered never-measured first, then oldest measurement first", () => {
  const now = Date.parse("2026-08-01T00:00:00Z");
  const threshold = 30 * DAY;
  const usage: UsageAggregate = {
    recent: { surfaced: 1, loaded: 0, acted_on: 0, last_sampled_at: "2026-06-20T00:00:00Z" },
    ancient: { surfaced: 1, loaded: 0, acted_on: 0, last_sampled_at: "2026-01-01T00:00:00Z" },
    ok: { surfaced: 1, loaded: 0, acted_on: 0, last_sampled_at: "2026-07-28T00:00:00Z" },
  };
  assert.deepEqual(
    dueForSampling(usage, ["recent", "ok", "b-never", "ancient", "a-never"], now, threshold),
    ["a-never", "b-never", "ancient", "recent"],
    "a caller with a probe budget slices from the front"
  );
  // Deterministic and duplicate-free — the same id twice is one probe.
  assert.deepEqual(dueForSampling(usage, ["ancient", "ancient", ""], now, threshold), ["ancient"]);
});

test("every memory is re-measured at least every T (hard bound, not a probability)", () => {
  const threshold = 30 * DAY;
  const start = Date.parse("2026-01-01T00:00:00Z");
  // 200 memories, each last measured somewhere in the past year.
  const usage: UsageAggregate = {};
  const ids: string[] = [];
  for (let i = 0; i < 200; i++) {
    const id = `m${String(i).padStart(3, "0")}`;
    ids.push(id);
    usage[id] = {
      surfaced: i,
      loaded: 0,
      acted_on: 0,
      last_sampled_at: new Date(start - i * 2 * DAY).toISOString(),
    };
  }
  const now = start + DAY;
  const due = new Set(dueForSampling(usage, ids, now, threshold));
  for (const id of ids) {
    const overdue = now - Date.parse(usage[id].last_sampled_at!) > threshold;
    assert.equal(due.has(id), overdue, `${id}: due iff past the floor, no exceptions`);
  }
});

// ─── the knob ────────────────────────────────────────────────────────────────

test("BASTRA_SAMPLE_ROT_DAYS tunes the floor; 0 forces every memory into the sample", () => {
  const prev = process.env.BASTRA_SAMPLE_ROT_DAYS;
  try {
    delete process.env.BASTRA_SAMPLE_ROT_DAYS;
    assert.equal(sampleRotThresholdMs(), 28 * DAY, "default: two heat half-lives");

    const entry = { surfaced: 1, loaded: 0, acted_on: 0, last_sampled_at: "2026-07-01T00:00:00Z" };
    const now = Date.parse("2026-07-21T00:00:00Z"); // 20 days later

    assert.equal(isSampleDue(entry, now), false, "20 days is inside the 28-day default");
    process.env.BASTRA_SAMPLE_ROT_DAYS = "7";
    assert.equal(sampleRotThresholdMs(), 7 * DAY);
    assert.equal(isSampleDue(entry, now), true, "a tighter floor pulls it in");
    process.env.BASTRA_SAMPLE_ROT_DAYS = "0";
    assert.equal(sampleRotThresholdMs(), 0);
    assert.equal(
      isSampleDue({ ...entry, last_sampled_at: new Date(now - 1000).toISOString() }, now),
      true,
      "floor 0: anything not measured in this very instant is due"
    );
    assert.equal(
      isSampleDue({ ...entry, last_sampled_at: new Date(now).toISOString() }, now),
      false,
      "…but a measurement taken now is a measurement, at every setting"
    );
    process.env.BASTRA_SAMPLE_ROT_DAYS = "-5";
    assert.equal(sampleRotThresholdMs(), 0, "negative clamps to 0, never to a negative window");
    process.env.BASTRA_SAMPLE_ROT_DAYS = "not-a-number";
    assert.equal(sampleRotThresholdMs(), 28 * DAY, "garbage falls back to the default");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_SAMPLE_ROT_DAYS;
    else process.env.BASTRA_SAMPLE_ROT_DAYS = prev;
  }
});
