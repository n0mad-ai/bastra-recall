/**
 * The Telemetry tab used to load its report once, on open, and then sit
 * frozen — nothing polled again, so a long-open tab (the Code-awareness
 * section included) went stale while the underlying event log kept growing.
 * createAutoRefresh() is the scheduling decision behind the fix: arm a
 * 30 s interval while the tab is open and the page visible, tear it down on
 * close, never stack a second interval on a repeated open, and pause (not
 * just skip a tick) while the tab is hidden.
 *
 * Dependency-injected and DOM-free, the same way hintSuppressionLabels() is
 * pinned in telemetry-view-suppression.test.ts — no real timers, no document.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/telemetry-view-refresh.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain browser module, no types (same as the other telemetry-view tests).
import { createAutoRefresh } from "../webui/js/managers/telemetry-view.js";

/** Stands in for setInterval/clearInterval: a call log plus incrementing ids,
 *  so "which timer got cleared" is checkable instead of inferred from timing. */
function fakeTimers() {
  let nextId = 1;
  const scheduled: Array<{ id: number; fn: () => void; ms: number }> = [];
  const cleared: number[] = [];
  return {
    scheduled,
    cleared,
    setIntervalFn: (fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.push({ id, fn, ms });
      return id;
    },
    clearIntervalFn: (id: number) => {
      if (id) cleared.push(id); // id 0 = "never armed" — clearing that is a no-op, not a call
    },
  };
}

test("arms a 30 s interval while open and visible, and the scheduled callback is the tick", () => {
  const t = fakeTimers();
  let ticks = 0;
  const r = createAutoRefresh({
    intervalMs: 30_000,
    isOpen: () => true,
    isHidden: () => false,
    tick: () => ticks++,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  r.arm();
  assert.equal(t.scheduled.length, 1);
  assert.equal(t.scheduled[0].ms, 30_000);
  t.scheduled[0].fn();
  assert.equal(ticks, 1);
});

test("never arms while the tab is closed", () => {
  const t = fakeTimers();
  const r = createAutoRefresh({
    intervalMs: 1000,
    isOpen: () => false,
    isHidden: () => false,
    tick: () => {},
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  r.arm();
  assert.equal(t.scheduled.length, 0);
  assert.equal(t.cleared.length, 0);
});

test("stops the interval once closed — what the manager's close() does", () => {
  const t = fakeTimers();
  let open = true;
  const r = createAutoRefresh({
    intervalMs: 1000,
    isOpen: () => open,
    isHidden: () => false,
    tick: () => {},
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  r.arm(); // open()
  assert.equal(t.scheduled.length, 1);
  open = false;
  r.arm(); // close()
  assert.equal(t.scheduled.length, 1, "no new interval once closed");
  assert.deepEqual(t.cleared, [1], "the running timer was torn down, not leaked");
});

test("repeated opens never stack a second interval", () => {
  const t = fakeTimers();
  const r = createAutoRefresh({
    intervalMs: 1000,
    isOpen: () => true,
    isHidden: () => false,
    tick: () => {},
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  r.arm();
  r.arm();
  r.arm();
  assert.equal(t.scheduled.length, 3, "one arm() per call, as the manager's own open() guard already dedupes real opens");
  assert.deepEqual(t.cleared, [1, 2], "each arm() clears the previous timer before scheduling the next — never two live at once");
});

test("pauses while hidden and resumes once visible again", () => {
  const t = fakeTimers();
  let hidden = false;
  const r = createAutoRefresh({
    intervalMs: 1000,
    isOpen: () => true,
    isHidden: () => hidden,
    tick: () => {},
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
  });
  r.arm();
  assert.equal(t.scheduled.length, 1);
  hidden = true;
  r.arm(); // what the manager's visibilitychange listener does
  assert.equal(t.scheduled.length, 1, "no new timer scheduled while hidden");
  assert.deepEqual(t.cleared, [1], "the visible-tab timer was cleared, not left running in the background");
  hidden = false;
  r.arm();
  assert.equal(t.scheduled.length, 2, "resumes once the tab is visible again");
});
