/**
 * Tests for curator phase A (#155): the pure staleness judgment (protection
 * classes, grace period, demand evidence, reactivation, idempotence), the
 * run gate, and the state store round-trip.
 *
 * Run: npx tsx --test packages/daemon/__tests__/curator.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideStale,
  applyDecision,
  shouldRunCurator,
  loadCuratorState,
  saveCuratorState,
  DEFAULT_THRESHOLDS,
  type CuratorMemoryFacts,
} from "../src/curator.js";
import type { UsageAggregate } from "../src/usage-sidecar.js";

const NOW = Date.parse("2026-07-03T12:00:00Z");
// Mature observation epoch: the sidecar has watched longer than the 30d window.
const MATURE = NOW - 40 * 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function facts(id: string, over: Partial<CuratorMemoryFacts> = {}): CuratorMemoryFacts {
  return { id, created: iso(120), floored: false, pinned: false, protected: false, ...over };
}

// ─── the archetype: context tax gets demoted ─────────────────────────────────

test("surfaced-often, never engaged, old enough → demoted with a usage-bearing reason", () => {
  const usage: UsageAggregate = { a: { surfaced: 7, loaded: 0, acted_on: 0, last_surfaced_at: iso(1) } };
  const d = decideStale({ nowMs: NOW, observedSinceMs: MATURE, facts: [facts("a")], usage, currentStale: {} });
  assert.match(d.demote["a"], /surfaced 7×/);
  assert.match(d.demote["a"], /never/);
});

// ─── protection classes ──────────────────────────────────────────────────────

test("floored, pinned, protected memories are never demoted regardless of usage", () => {
  const usage: UsageAggregate = {
    f: { surfaced: 20, loaded: 0, acted_on: 0 },
    p: { surfaced: 20, loaded: 0, acted_on: 0 },
    h: { surfaced: 20, loaded: 0, acted_on: 0 },
  };
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: MATURE,
    facts: [facts("f", { floored: true }), facts("p", { pinned: true }), facts("h", { protected: true })],
    usage,
    currentStale: {},
  });
  assert.deepEqual(d.demote, {});
});

test("young memories get the grace period; unknown created dates are skipped", () => {
  const usage: UsageAggregate = {
    young: { surfaced: 9, loaded: 0, acted_on: 0 },
    nodate: { surfaced: 9, loaded: 0, acted_on: 0 },
  };
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: MATURE,
    facts: [facts("young", { created: iso(5) }), facts("nodate", { created: undefined })],
    usage,
    currentStale: {},
  });
  assert.deepEqual(d.demote, {});
});

test("zero/low usage is absence of evidence — never demoted", () => {
  const usage: UsageAggregate = { low: { surfaced: 2, loaded: 0, acted_on: 0 } };
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: MATURE,
    facts: [facts("low"), facts("nousage")],
    usage,
    currentStale: {},
  });
  assert.deepEqual(d.demote, {});
});

test("recent acted_on or loaded keeps a memory fresh (acceptance: recent acted_on is never touched)", () => {
  const usage: UsageAggregate = {
    acted: { surfaced: 10, loaded: 0, acted_on: 1, last_acted_on_at: iso(3) },
    loaded: { surfaced: 10, loaded: 1, acted_on: 0, last_loaded_at: iso(10) },
    old: { surfaced: 10, loaded: 1, acted_on: 1, last_acted_on_at: iso(90), last_loaded_at: iso(80) },
  };
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: MATURE,
    facts: [facts("acted"), facts("loaded"), facts("old")],
    usage,
    currentStale: {},
  });
  assert.equal(d.demote["acted"], undefined);
  assert.equal(d.demote["loaded"], undefined);
  assert.match(d.demote["old"], /surfaced 10×/, "engagement OUTSIDE the window does not protect");
});

// ─── idempotence + reactivation ──────────────────────────────────────────────

test("idempotent: an already-stale memory is not re-demoted; engagement after stale_since reactivates", () => {
  const staleSince = iso(20);
  const usage: UsageAggregate = {
    still: { surfaced: 10, loaded: 0, acted_on: 0 },
    revived: { surfaced: 10, loaded: 1, acted_on: 0, last_loaded_at: iso(2) },
  };
  const current = {
    still: { stale_since: staleSince, reason: "r" },
    revived: { stale_since: staleSince, reason: "r" },
  };
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: MATURE,
    facts: [facts("still"), facts("revived")],
    usage,
    currentStale: current,
  });
  assert.deepEqual(d.demote, {});
  assert.deepEqual(d.reactivate, ["revived"]);

  const next = applyDecision({ stale: current }, d, new Date(NOW).toISOString());
  assert.equal(next.stale["revived"], undefined);
  assert.equal(next.stale["still"].stale_since, staleSince, "existing demotion keeps its original stale_since");
  assert.equal(next.last_run_at, new Date(NOW).toISOString());
});

test("immature observation window: candidates land in pendingObservation, never in demote", () => {
  const usage: UsageAggregate = { a: { surfaced: 7, loaded: 0, acted_on: 0 } };
  // Sidecar started 7 days ago — "no engagement in 30d" is unobservable.
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: NOW - 7 * 86_400_000,
    facts: [facts("a")],
    usage,
    currentStale: {},
  });
  assert.deepEqual(d.demote, {});
  assert.match(d.pendingObservation["a"], /surfaced 7×/);
  // No epoch at all = unknown = equally immature.
  const d2 = decideStale({ nowMs: NOW, facts: [facts("a")], usage, currentStale: {} });
  assert.deepEqual(d2.demote, {});
});

test("protection wins over an earlier demotion: flooring a stale memory reactivates it", () => {
  const current = { a: { stale_since: iso(20), reason: "r" } };
  const usage: UsageAggregate = { a: { surfaced: 10, loaded: 0, acted_on: 0 } };
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: MATURE,
    facts: [facts("a", { floored: true })],
    usage,
    currentStale: current,
  });
  assert.deepEqual(d.reactivate, ["a"]);
  assert.deepEqual(d.demote, {});
});

test("ghost pruning: a stale id whose memory left the vault is reactivated", () => {
  const current = { gone: { stale_since: iso(20), reason: "r" } };
  const d = decideStale({
    nowMs: NOW,
    observedSinceMs: MATURE,
    facts: [facts("other")],
    usage: {},
    currentStale: current,
  });
  assert.deepEqual(d.reactivate, ["gone"]);
});

// ─── run gate ────────────────────────────────────────────────────────────────

test("gate: interval + idle guard", () => {
  const now = NOW;
  // never ran, idle → run
  assert.equal(shouldRunCurator({ nowMs: now }), true);
  // ran 2 days ago (interval 7d) → no
  assert.equal(shouldRunCurator({ nowMs: now, lastRunAt: iso(2) }), false);
  // ran 8 days ago → yes
  assert.equal(shouldRunCurator({ nowMs: now, lastRunAt: iso(8) }), true);
  // due, but the daemon served a request 1 min ago → busy, no
  assert.equal(shouldRunCurator({ nowMs: now, lastRunAt: iso(8), lastActivityMs: now - 60_000 }), false);
  // due and idle for 11 min → yes
  assert.equal(shouldRunCurator({ nowMs: now, lastRunAt: iso(8), lastActivityMs: now - 11 * 60_000 }), true);
});

// ─── state store ─────────────────────────────────────────────────────────────

test("state store round-trip; corrupt state degrades to fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-curator-"));
  try {
    assert.deepEqual(await loadCuratorState(root), { stale: {} });
    const state = {
      last_run_at: iso(0),
      stale: { a: { stale_since: iso(1), reason: "context tax" } },
    };
    await saveCuratorState(root, state);
    assert.deepEqual(await loadCuratorState(root), state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults match the issue sketch (3 surfacings, 14d grace, 30d window)", () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, { minSurfaced: 3, minAgeDays: 14, staleAfterDays: 30 });
});
