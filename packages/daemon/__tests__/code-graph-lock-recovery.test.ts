import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CodeGraphRefresher } from "../src/code-graph/refresh.js";
import type { BuildResult } from "../src/code-graph/build.js";

const HOUR = 60 * 60_000;
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
async function initialBurst(t: TestContext): Promise<void> {
  for (const wait of [10_000, 20_000, 40_000, 80_000, 160_000, 320_000]) {
    t.mock.timers.tick(wait); await settled();
  }
}
const ok: BuildResult = { ok: true, durationMs: 1, tookOverLock: false, manifest: {
  graphifyVersion: "fixture", builtAt: "2026-10-10T00:00:00Z", commit: null,
  repoRoot: "/fixture", command: "fixture", fileState: { count: 1, newestMtimeMs: 1 }, lastError: null, dirty: false,
} };

test("K1: a fifteen-minute lock recovers on the hourly attempt and normal triggers work again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  const refresher = new CodeGraphRefresher({ debounceMs: 0, build: async () => {
    calls++; return Date.now() < 15 * 60_000 ? { ok: false, reason: "locked", detail: "invented lease" } : ok;
  } });
  try {
    refresher.enqueue("/fixture", "git"); t.mock.timers.tick(0); await settled();
    await initialBurst(t); assert.equal(calls, 7); assert.equal(refresher.statusOf("/fixture")?.givenUp, true);
    t.mock.timers.tick(270_000); await settled(); assert.equal(calls, 7, "lock has just become free at fifteen minutes");
    t.mock.timers.tick(HOUR - 270_000 - 1); await settled(); assert.equal(calls, 7);
    t.mock.timers.tick(1); await settled(); assert.equal(calls, 8);
    assert.equal(refresher.statusOf("/fixture")?.givenUp, false);
    assert.equal(refresher.statusOf("/fixture")?.lastError, null);
    for (const reason of ["watcher", "git", "stop-hook", "startup"] as const) {
      const before: number = calls;
      refresher.enqueue("/fixture", reason); t.mock.timers.tick(0); await settled();
      assert.equal(calls, before + 1, reason);
    }
  } finally { refresher.stop(); }
});

test("K1: a permanent lock costs at most one attempt per hour after the initial burst", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const refresher = new CodeGraphRefresher({ build: async () => { calls++; return { ok: false, reason: "locked", detail: "invented lease" }; } });
  try {
    refresher.enqueue("/fixture", "git"); t.mock.timers.tick(0); await settled();
    await initialBurst(t); assert.equal(calls, 7);
    for (let hour = 0; hour < 10; hour++) {
      for (const reason of ["watcher", "git", "stop-hook", "startup"] as const)
        for (let n = 0; n < 20; n++) refresher.enqueue("/fixture", reason);
      t.mock.timers.tick(HOUR - 1); await settled(); assert.equal(calls, 7 + hour);
      t.mock.timers.tick(1); await settled(); assert.equal(calls, 8 + hour);
    }
    assert.equal(refresher.statusOf("/fixture")?.givenUp, true);
    assert.equal(refresher.statusOf("/fixture")?.failures, 0);
  } finally { refresher.stop(); }
});

test("K1: a recovered lock followed by real build failures keeps the existing permanent stop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, locked = true;
  const refresher = new CodeGraphRefresher({ backoffMs: [10, 20], build: async () => {
    calls++; return { ok: false, reason: locked ? "locked" : "failed", detail: "invented failure" };
  } });
  try {
    refresher.enqueue("/fixture", "git"); t.mock.timers.tick(0); await settled();
    await initialBurst(t); locked = false;
    t.mock.timers.tick(HOUR); await settled(); assert.equal(calls, 8);
    assert.equal(refresher.statusOf("/fixture")?.givenUp, false);
    t.mock.timers.tick(10); await settled(); t.mock.timers.tick(20); await settled();
    assert.equal(calls, 10); assert.equal(refresher.statusOf("/fixture")?.givenUp, true);
    refresher.enqueue("/fixture", "git"); t.mock.timers.tick(24 * HOUR); await settled();
    assert.equal(calls, 10, "real build failures gain no hourly retry");
  } finally { refresher.stop(); }
});
