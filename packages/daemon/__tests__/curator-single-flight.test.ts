/**
 * #538 — two curator passes must never run at the same time.
 *
 * A pass starts from the 15-minute background tick (daemon-jobs.ts) and from
 * POST /curator/run (curator-run.ts). Both are served by the daemon process —
 * no CLI command and no second process runs a pass — so the single-flight
 * register in curator-run.ts covers every entry point there is.
 *
 * Without it, two overlapping passes each ran the full vault scan, each
 * called `setDemotions`, each rewrote REPORT.md and the journal, and the
 * later `saveCuratorState` decided the file — a read-modify-write whose read
 * happened a whole scan earlier.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCuratorPass, type CuratorRunDeps } from "../src/curator-run.js";
import { recordUsage } from "../src/usage-sidecar.js";
import { loadCuratorState } from "../src/curator.js";

const NOW = Date.parse("2026-07-03T12:00:00Z");
const T_ACT = NOW + 31 * 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function fakeVault(mems: Array<Record<string, unknown>>): CuratorRunDeps["vault"] {
  const map = new Map(mems.map((fm) => [fm.id as string, { fm }]));
  return { list: () => [...map.values()], get: (id: string) => map.get(id), size: () => map.size };
}

async function withFixture<T>(
  fn: (root: string, deps: CuratorRunDeps, demotionCalls: string[][]) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bastra-curator-538-"));
  const floorsPath = join(root, "floors.json");
  await writeFile(floorsPath, "[]", "utf8");
  await recordUsage(root, [
    ...Array.from({ length: 5 }, (_, i) => ({ id: "tax", kind: "surfaced" as const, ts: iso(30 - i) })),
  ]);
  const demotionCalls: string[][] = [];
  const deps: CuratorRunDeps = {
    vaultRoot: root,
    vault: fakeVault([
      { id: "tax", title: "Old unused lesson", created: iso(120), topic_path: ["css"], related: [] },
    ]),
    setDemotions: (ids) => demotionCalls.push([...ids]),
  };
  const prev = process.env.BASTRA_FLOORS_PATH;
  process.env.BASTRA_FLOORS_PATH = floorsPath;
  try {
    return await fn(root, deps, demotionCalls);
  } finally {
    if (prev === undefined) delete process.env.BASTRA_FLOORS_PATH;
    else process.env.BASTRA_FLOORS_PATH = prev;
    await rm(root, { recursive: true, force: true });
  }
}

test("#538: two overlapping passes — exactly one runs, the other is refused", async () => {
  await withFixture(async (root, deps, demotionCalls) => {
    await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW }); // review-first
    demotionCalls.length = 0;

    // The 15-min tick and POST /curator/run firing in the same moment.
    const results = await Promise.all([
      runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT }),
      runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT }),
    ]);
    const ran = results.filter((r) => r.ran);
    const refused = results.filter((r) => !r.ran);
    assert.equal(ran.length, 1, "exactly one pass does the work");
    assert.equal(refused.length, 1, "the other is refused");
    // Refused, not silently discarded: the caller is told why.
    assert.equal(refused[0]?.skipped, "in-progress");
    assert.equal(refused[0]?.demoted.length, 0);
    // No duplicated expensive work: one index update, one report.
    assert.equal(demotionCalls.length, 1, "setDemotions called once");
    assert.equal(results.filter((r) => r.reportWritten).length, 1, "REPORT.md written once");

    // The persisted state is the running pass's, whole.
    const state = await loadCuratorState(root);
    assert.deepEqual(Object.keys(state.stale), ran[0]?.demoted);
    assert.equal(state.last_run_at, new Date(T_ACT).toISOString());
  });
});

test("#538: a refused pass still reports the vault's real stale count", async () => {
  await withFixture(async (_root, deps) => {
    await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW });
    await runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT });
    const [, refused] = await Promise.all([
      runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT + 1000 }),
      runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT + 1000 }),
    ]);
    assert.equal(refused.skipped, "in-progress");
    assert.equal(refused.staleTotal, 1, "the refusal reads the real state, it does not report zero");
  });
});

test("#538: a manual dry run is never answered with the acting pass's result", async () => {
  await withFixture(async (_root, deps) => {
    await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW });
    const [acting, manual] = await Promise.all([
      runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT }),
      runCuratorPass(deps, { force: true, dryRun: true, nowMs: T_ACT }),
    ]);
    assert.equal(acting.ran, true);
    assert.equal(acting.dryRun, false);
    // The refusal keeps the caller's own mode — joining the acting pass would
    // answer a review request with demotions it never consented to.
    assert.equal(manual.ran, false);
    assert.equal(manual.skipped, "in-progress");
    assert.equal(manual.dryRun, true);
    assert.equal(manual.mode, "dry-run");
  });
});

test("#538: the flight is released — a later pass runs normally", async () => {
  await withFixture(async (_root, deps) => {
    await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW });
    await Promise.all([
      runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT }),
      runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT }),
    ]);
    const later = await runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT + 5000 });
    assert.equal(later.ran, true);
    assert.equal(later.skipped, undefined);
  });
});

test("#538: a failing pass does not wedge the flight", async () => {
  await withFixture(async (_root, deps) => {
    const broken: CuratorRunDeps = {
      ...deps,
      vault: {
        list: () => {
          throw new Error("vault exploded");
        },
        get: () => undefined,
        size: () => 0,
      },
    };
    const failed = await runCuratorPass(broken, { force: true, dryRun: false, nowMs: NOW });
    assert.equal(failed.ran, false);
    assert.ok(failed.error, "the failure is reported, not thrown");
    const after = await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW });
    assert.equal(after.ran, true, "the next pass is not locked out");
  });
});

test("#538: passes on different vault roots do not block each other", async () => {
  await withFixture(async (_rootA, depsA) => {
    await withFixture(async (_rootB, depsB) => {
      const [a, b] = await Promise.all([
        runCuratorPass(depsA, { force: true, dryRun: false, nowMs: NOW }),
        runCuratorPass(depsB, { force: true, dryRun: false, nowMs: NOW }),
      ]);
      assert.equal(a.ran, true);
      assert.equal(b.ran, true);
    });
  });
});
