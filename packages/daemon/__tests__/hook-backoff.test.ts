/**
 * Unit tests for the #161 empty-streak backoff (session-state.ts).
 *
 * Covers:
 *   - decideBackoff matrix: no entry, min-streak threshold, skipped window,
 *     cap at BACKOFF_STREAK_CAP, consumption reset, malformed entries,
 *     REQUIRED-band bypass (hasRequired)
 *   - recordSourceEmit: streak growth, reset on consumption, ids cap
 *   - recordSourceSuppressed: skipped counter, defensive no-op
 *   - suppression cadence over a simulated event stream (E E E S S E …)
 *   - wasEmitConsumed against real load-markers
 *   - session-state round-trip preserves the `sources` section
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir = "";

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "bastra-backoff-test-"));
  process.env.BASTRA_HOOK_STATE_DIR = testDir;
});

after(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
  delete process.env.BASTRA_HOOK_STATE_DIR;
});

// Import AFTER env override so sessionStateDir() picks up the test dir.
const ss = await import("../src/session-state.js");
// #542: `const ss = await import(...)` only binds `ss` as a value, not a
// type namespace — `ss.SourceBackoff` in a type position doesn't resolve
// once the test tree is type-checked. These aliases give the same names
// back in type space without a second (and colliding) import.
type SessionState = import("../src/session-state.js").SessionState;
type SourceBackoff = import("../src/session-state.js").SourceBackoff;

function entry(streak: number, skipped: number, at = 1_000_000): SourceBackoff {
  return { streak, at, ids: ["mem-a"], skipped };
}

// ── decideBackoff matrix ────────────────────────────────────────────────────

test("decideBackoff: no entry → never suppress", () => {
  assert.deepEqual(ss.decideBackoff(undefined, false, false), { suppress: false, streak: 0 });
});

test("decideBackoff: streak below MIN_STREAK → emit", () => {
  assert.equal(ss.decideBackoff(entry(0, 0), false, false).suppress, false);
  assert.equal(ss.decideBackoff(entry(ss.BACKOFF_MIN_STREAK - 1, 0), false, false).suppress, false);
});

test("decideBackoff: streak at MIN_STREAK, window open → suppress", () => {
  const d = ss.decideBackoff(entry(ss.BACKOFF_MIN_STREAK, 0), false, false);
  assert.equal(d.suppress, true);
  assert.equal(d.streak, ss.BACKOFF_MIN_STREAK);
});

test("decideBackoff: skipped < streak keeps suppressing, then probes", () => {
  assert.equal(ss.decideBackoff(entry(3, 0), false, false).suppress, true);
  assert.equal(ss.decideBackoff(entry(3, 2), false, false).suppress, true);
  // window exhausted → probe emit
  assert.equal(ss.decideBackoff(entry(3, 3), false, false).suppress, false);
});

test("decideBackoff: cap — streak beyond CAP needs only CAP skips", () => {
  assert.equal(ss.decideBackoff(entry(12, ss.BACKOFF_STREAK_CAP - 1), false, false).suppress, true);
  assert.equal(ss.decideBackoff(entry(12, ss.BACKOFF_STREAK_CAP), false, false).suppress, false);
});

test("decideBackoff: consumption resets streak to 0 → emit", () => {
  const d = ss.decideBackoff(entry(7, 1), true, false);
  assert.deepEqual(d, { suppress: false, streak: 0 });
});

test("decideBackoff: malformed entry fails open", () => {
  const broken = { streak: "x", at: 1, skipped: 0 } as unknown as SourceBackoff;
  assert.deepEqual(ss.decideBackoff(broken, false, false), { suppress: false, streak: 0 });
  const noEmit = entry(5, 0, 0); // at <= 0 → never emitted
  assert.deepEqual(ss.decideBackoff(noEmit, false, false), { suppress: false, streak: 0 });
});

// ── REQUIRED-band bypass (hasRequired) ──────────────────────────────────────

test("decideBackoff: hasRequired bypasses suppression at every streak level", () => {
  // Every state that would suppress without a REQUIRED hit must emit with one.
  const wouldSuppress = [
    entry(ss.BACKOFF_MIN_STREAK, 0),
    entry(3, 2),
    entry(12, ss.BACKOFF_STREAK_CAP - 1),
    entry(50, 0),
  ];
  for (const e of wouldSuppress) {
    assert.equal(ss.decideBackoff(e, false, false).suppress, true, "precondition: suppresses");
    const d = ss.decideBackoff(e, false, true);
    assert.equal(d.suppress, false, `hasRequired must bypass (streak ${e.streak})`);
    // Streak resolution is unchanged — bypass is not a consumption signal.
    assert.equal(d.streak, e.streak);
  }
});

test("decideBackoff: hasRequired matrix — no entry / consumed / malformed stay identical", () => {
  assert.deepEqual(ss.decideBackoff(undefined, false, true), { suppress: false, streak: 0 });
  assert.deepEqual(ss.decideBackoff(entry(7, 1), true, true), { suppress: false, streak: 0 });
  const broken = { streak: "x", at: 1, skipped: 0 } as unknown as SourceBackoff;
  assert.deepEqual(ss.decideBackoff(broken, false, true), { suppress: false, streak: 0 });
});

// ── recordSourceEmit / recordSourceSuppressed ───────────────────────────────

test("recordSourceEmit: first emit starts at streak 0", () => {
  const state: SessionState = { shown: {} };
  ss.recordSourceEmit(state, "write-edit", ["m1", "m2"], false, 5000);
  assert.deepEqual(state.sources?.["write-edit"], {
    streak: 0,
    at: 5000,
    ids: ["m1", "m2"],
    skipped: 0,
  });
});

test("recordSourceEmit: unconsumed previous emit increments streak, resets skipped", () => {
  const state: SessionState = { shown: {}, sources: { s: entry(2, 2) } };
  ss.recordSourceEmit(state, "s", ["m3"], false, 6000);
  assert.deepEqual(state.sources?.s, { streak: 3, at: 6000, ids: ["m3"], skipped: 0 });
});

test("recordSourceEmit: consumed previous emit resets streak to 0", () => {
  const state: SessionState = { shown: {}, sources: { s: entry(7, 4) } };
  ss.recordSourceEmit(state, "s", ["m3"], true, 6000);
  assert.equal(state.sources?.s.streak, 0);
});

test("recordSourceEmit: ids are capped to bound state size", () => {
  const state: SessionState = { shown: {} };
  const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
  ss.recordSourceEmit(state, "s", many, false, 1);
  assert.equal(state.sources?.s.ids.length, 10);
});

test("recordSourceEmit: sources back off independently", () => {
  const state: SessionState = { shown: {}, sources: { a: entry(4, 0) } };
  ss.recordSourceEmit(state, "b", ["m1"], false, 1);
  assert.equal(state.sources?.a.streak, 4); // untouched
  assert.equal(state.sources?.b.streak, 0);
});

test("recordSourceSuppressed: increments skipped; no-op without entry", () => {
  const state: SessionState = { shown: {}, sources: { s: entry(2, 0) } };
  ss.recordSourceSuppressed(state, "s");
  ss.recordSourceSuppressed(state, "s");
  assert.equal(state.sources?.s.skipped, 2);
  ss.recordSourceSuppressed(state, "missing"); // must not throw
  assert.equal(state.sources?.missing, undefined);
});

// ── suppression cadence over a simulated event stream ──────────────────────

/** Mimics one injection-worthy hook event: decide, then commit the outcome. */
function driveEvent(
  state: SessionState,
  source: string,
  consumed: boolean,
  now: number,
  hasRequired = false,
): boolean {
  const d = ss.decideBackoff(state.sources?.[source], consumed, hasRequired);
  if (d.suppress) {
    ss.recordSourceSuppressed(state, source);
    return false; // suppressed
  }
  ss.recordSourceEmit(state, source, ["mem-a"], consumed, now);
  return true; // emitted
}

test("cadence: never-consumed source widens deterministically (E E E S S E S S S E)", () => {
  const state: SessionState = { shown: {} };
  const pattern: string[] = [];
  for (let i = 0; i < 10; i++) {
    pattern.push(driveEvent(state, "s", false, 1000 + i) ? "E" : "S");
  }
  assert.equal(pattern.join(" "), "E E E S S E S S S E");
  // streak after the 5th emit: 4 unconsumed emits counted
  assert.equal(state.sources?.s.streak, 4);
});

test("cadence: skip requirement never exceeds the cap", () => {
  const state: SessionState = { shown: {}, sources: { s: entry(50, 0) } };
  let skips = 0;
  while (!driveEvent(state, "s", false, 2000)) skips++;
  assert.equal(skips, ss.BACKOFF_STREAK_CAP);
});

test("cadence: REQUIRED emission mid-window emits as a REGULAR emission — streak grows, only consumption resets", () => {
  const state: SessionState = { shown: {}, sources: { s: entry(3, 0) } };
  // Suppression window is open (streak 3, skipped 0) — a REQUIRED hit still emits…
  assert.equal(driveEvent(state, "s", false, 4000, true), true);
  // …and is booked as a regular unconsumed emit: streak 3 → 4, not reset.
  assert.equal(state.sources?.s.streak, 4);
  assert.equal(state.sources?.s.skipped, 0);
  // The next optional-only event goes back to suppression (window re-opened).
  assert.equal(driveEvent(state, "s", false, 4001, false), false);
  assert.equal(state.sources?.s.skipped, 1);
  // Only consumption resets the streak — even alongside a REQUIRED hit.
  assert.equal(driveEvent(state, "s", true, 4002, true), true);
  assert.equal(state.sources?.s.streak, 0);
});

test("cadence: consumption mid-window re-opens immediately and resets streak", () => {
  const state: SessionState = { shown: {}, sources: { s: entry(5, 1) } };
  // Suppression would continue (skipped 1 < 5), but a load-marker arrived:
  assert.equal(driveEvent(state, "s", true, 3000), true);
  assert.equal(state.sources?.s.streak, 0);
  // Next unconsumed event emits normally again (streak 0 → 1).
  assert.equal(driveEvent(state, "s", false, 3001), true);
  assert.equal(state.sources?.s.streak, 1);
});

// ── wasEmitConsumed against real load-markers ───────────────────────────────

test("wasEmitConsumed: marker newer than emit → consumed", async () => {
  const e: SourceBackoff = { streak: 1, at: Date.now() - 5000, ids: ["backoff-mem-1"], skipped: 0 };
  assert.equal(await ss.wasEmitConsumed(e), false, "no marker yet");
  await ss.touchLoadedMarker("backoff-mem-1");
  assert.equal(await ss.wasEmitConsumed(e), true);
});

test("wasEmitConsumed: marker older than emit → not consumed", async () => {
  await ss.touchLoadedMarker("backoff-mem-2");
  const e: SourceBackoff = { streak: 1, at: Date.now() + 60_000, ids: ["backoff-mem-2"], skipped: 0 };
  assert.equal(await ss.wasEmitConsumed(e), false);
});

test("wasEmitConsumed: undefined entry / empty ids / malformed → false", async () => {
  assert.equal(await ss.wasEmitConsumed(undefined), false);
  assert.equal(await ss.wasEmitConsumed({ streak: 1, at: 1, ids: [], skipped: 0 }), false);
  const broken = { streak: 1, at: 1, ids: "nope", skipped: 0 } as unknown as SourceBackoff;
  assert.equal(await ss.wasEmitConsumed(broken), false);
});

// ── session-state round-trip ────────────────────────────────────────────────

test("round-trip: sources section survives save → load", async () => {
  const sessionId = "session-backoff-roundtrip";
  const state: SessionState = {
    shown: { "mem-a": { count: 1, at: 123 } },
    sources: {
      "write-edit": { streak: 3, at: 456, ids: ["m1", "m2"], skipped: 2 },
      "bash-tripwire": { streak: 0, at: 789, ids: ["m3"], skipped: 0 },
    },
  };
  await ss.saveSessionState(sessionId, state);
  const loaded = await ss.loadSessionState(sessionId);
  assert.deepEqual(loaded, state);
});

test("round-trip: legacy state without sources loads cleanly", async () => {
  const sessionId = "session-backoff-legacy";
  await ss.saveSessionState(sessionId, { shown: { m: { count: 1, at: 1 } } });
  const loaded = await ss.loadSessionState(sessionId);
  assert.equal(loaded.sources, undefined);
  assert.deepEqual(loaded.shown, { m: { count: 1, at: 1 } });
});
