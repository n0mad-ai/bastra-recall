import { test } from "node:test";
import assert from "node:assert/strict";
import { startStagedRestart } from "../src/daemon-jobs.js";

const minute = 60_000;
function fixture(owned = true, pendingInitially = true) {
  let pending = pendingInitially;
  let shutdowns = 0;
  let clears = 0;
  const activity = Date.now();
  return {
    deps: {
      launchAgentOwned: owned,
      isStagedRestartPending: () => pending,
      getLastActivity: () => activity,
      clearStagedRestartPending: () => { pending = false; clears++; },
      shutdown: async () => { shutdowns++; },
    },
    state: () => ({ pending, shutdowns, clears }),
  };
}

test("Windows managed task stays warm with a pending staged update after the idle deadline", t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  const f = fixture();
  startStagedRestart(f.deps, "win32");
  t.mock.timers.tick(30 * minute);
  assert.deepEqual(f.state(), { pending: true, shutdowns: 0, clears: 0 });
});

test("macOS KeepAlive service cleanly restarts only after 15 minutes idle with a pending update", t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  t.mock.method(console, "error", () => {});
  const f = fixture();
  startStagedRestart(f.deps, "darwin");
  t.mock.timers.tick(14 * minute);
  assert.deepEqual(f.state(), { pending: true, shutdowns: 0, clears: 0 });
  t.mock.timers.tick(minute);
  assert.deepEqual(f.state(), { pending: false, shutdowns: 1, clears: 1 });
  t.mock.timers.tick(15 * minute);
  assert.equal(f.state().shutdowns, 1, "cleared pending flag prevents repeated shutdown");
});

test("macOS service without a pending update stays warm beyond the idle deadline", t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  const f = fixture(true, false);
  startStagedRestart(f.deps, "darwin");
  t.mock.timers.tick(30 * minute);
  assert.deepEqual(f.state(), { pending: false, shutdowns: 0, clears: 0 });
});

for (const platform of ["darwin", "win32"] as const) {
  test(`${platform} forwarder is unaffected by the managed-service staged-restart job`, t => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
    const f = fixture(false);
    startStagedRestart(f.deps, platform);
    t.mock.timers.tick(30 * minute);
    assert.deepEqual(f.state(), { pending: true, shutdowns: 0, clears: 0 });
  });
}
