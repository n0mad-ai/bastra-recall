import { test } from "node:test";
import { strict as assert } from "node:assert";

import { foldClientDuplicates, DUPLICATE_WINDOW_MS, tsOf } from "../src/cli/log-stats-phases.js";

/**
 * #615 — `foldClientDuplicates` (log-stats-phases.ts) used to rescan the
 * whole `events` array for every client row: O(client rows × all events).
 * Harmless at the sizes #305's own tests use, but a real multi-week log runs
 * into the tens of thousands of rows. These tests pin that the indexed
 * version is still the same fold — same matches, same tie-break, same status
 * rewrite — and that it actually is fast at that size.
 *
 * The correctness-shaping cases (client/daemon split, session identity, the
 * window, status precedence) already live in log-stats.test.ts next to
 * `aggregate`; this file does not repeat them.
 */

/** Deterministic PRNG (mulberry32) — the generated sets below must be identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A copy of the fold exactly as it read before #615: for every client row,
// rescan the whole `events` array. Kept only so the indexed version can be
// checked against it — this is the O(client rows × all events) scan the
// index replaced, not something to reuse elsewhere.
const REFERENCE_CLIENT_ROW_VERSION = /-(stub|thin)$/;
function referenceIsClientRow(e: Record<string, unknown>): boolean {
  return REFERENCE_CLIENT_ROW_VERSION.test(String(e.hook_version ?? ""));
}
function referenceSessionOf(e: Record<string, unknown>): string | null {
  return typeof e.session_id === "string" && e.session_id.length > 0 ? e.session_id : null;
}
function referenceFoldClientDuplicates(
  events: Array<Record<string, unknown>>,
): { events: Array<Record<string, unknown>>; folded: number } {
  const clients = events.filter(referenceIsClientRow);
  if (clients.length === 0) return { events, folded: 0 };
  const dropped = new Set<Record<string, unknown>>();
  const taken = new Set<Record<string, unknown>>();
  const copies = new Map<Record<string, unknown>, Record<string, unknown>>();
  for (const client of clients.sort((a, b) => tsOf(a) - tsOf(b))) {
    const at = tsOf(client);
    const session = referenceSessionOf(client);
    if (session === null) continue;
    let best: Record<string, unknown> | null = null;
    let bestGap = Infinity;
    for (const e of events) {
      if (e === client || taken.has(e) || referenceIsClientRow(e) || e.kind !== client.kind) continue;
      if (referenceSessionOf(e) !== session) continue;
      const gap = Math.abs(tsOf(e) - at);
      if (gap <= DUPLICATE_WINDOW_MS && gap < bestGap) {
        best = e;
        bestGap = gap;
      }
    }
    if (!best) continue;
    taken.add(best);
    dropped.add(client);
    const status = String(best.status ?? "");
    if (status !== "timeout" && status !== "error" && status !== "daemon-unreachable") {
      copies.set(best, { ...best, status: client.status });
    }
  }
  if (dropped.size === 0) return { events, folded: 0 };
  return {
    events: events.filter((e) => !dropped.has(e)).map((e) => copies.get(e) ?? e),
    folded: dropped.size,
  };
}

/**
 * `callCount` daemon/client pairs across `sessionCount` sessions and 5 kinds
 * (250 distinct session×kind buckets at sessionCount=50). ~85% of pairs sit
 * inside the fold window (a real duplicate), the rest just outside it; ~3%
 * of client rows drop their session (unidentifiable, must stay their own
 * call). Deterministic in `seed`.
 */
function pairedEventSet(seed: number, callCount: number, sessionCount: number): Array<Record<string, unknown>> {
  const rand = mulberry32(seed);
  const kinds = ["prompt_hook_call", "hook_call", "todo_hook_call", "bash_hook_call", "session_hook_call"];
  const statuses = ["ok", "timeout", "error", "daemon-unreachable", "gated"];
  const baseTs = Date.parse("2026-09-06T05:00:00.000Z");
  const events: Array<Record<string, unknown>> = [];
  for (let i = 0; i < callCount; i++) {
    const kind = kinds[i % kinds.length];
    // Decoupled from `kind`'s own period so all sessionCount×5 buckets fill.
    const session = `session-${Math.floor(i / kinds.length) % sessionCount}`;
    const anchor = baseTs + i * 1500;
    events.push({
      kind,
      ts: new Date(anchor).toISOString(),
      session_id: session,
      status: statuses[Math.floor(rand() * statuses.length)],
      hint_count: Math.floor(rand() * 5),
      latency_ms_total: Math.floor(rand() * 900),
    });
    const withinWindow = rand() < 0.85;
    const offset = withinWindow
      ? Math.floor(rand() * DUPLICATE_WINDOW_MS)
      : DUPLICATE_WINDOW_MS + 50 + Math.floor(rand() * 2000);
    const dropSession = rand() < 0.03;
    events.push({
      kind,
      ts: new Date(anchor + offset).toISOString(),
      session_id: dropSession ? undefined : session,
      hook_version: rand() > 0.5 ? "0.6.0-stub" : "0.6.0-thin",
      status: statuses[Math.floor(rand() * statuses.length)],
      hint_count: 0,
      latency_ms_total: Math.floor(rand() * 900),
    });
  }
  return events;
}

test("#615: the indexed fold matches the pre-#615 nested-loop fold, ties included", () => {
  const events = pairedEventSet(20260921, 300, 6);
  // Force an exact tie inside one bucket: two daemon rows equidistant (250ms)
  // from one client row, same session and kind. Both old and new code pick
  // the nearest under strict `gap < bestGap`, so on a tie the row that comes
  // first in `events` order must win — the indexed version must preserve
  // that order inside its bucket, not just get the right row by luck.
  const tieAt = Date.parse("2026-09-06T05:30:00.000Z");
  events.push(
    { kind: "prompt_hook_call", ts: new Date(tieAt - 250).toISOString(), session_id: "session-tie", status: "ok", hint_count: 1, latency_ms_total: 100 },
    { kind: "prompt_hook_call", ts: new Date(tieAt + 250).toISOString(), session_id: "session-tie", status: "ok", hint_count: 2, latency_ms_total: 120 },
    { kind: "prompt_hook_call", ts: new Date(tieAt).toISOString(), session_id: "session-tie", hook_version: "0.6.0-stub", status: "timeout", hint_count: 0, latency_ms_total: 500 },
  );

  const expected = referenceFoldClientDuplicates(events);
  const actual = foldClientDuplicates(events);

  assert.equal(actual.folded, expected.folded);
  assert.deepEqual(actual.events, expected.events);
  assert.ok(expected.folded > 200, "the generated set must actually exercise a lot of real folds, or this proves little");

  const winner = actual.events.find((e) => e.session_id === "session-tie" && e.latency_ms_total === 100);
  assert.equal(winner?.status, "timeout", "the earlier row in `events` order must win the tie");
  const loser = actual.events.find((e) => e.session_id === "session-tie" && e.latency_ms_total === 120);
  assert.equal(loser?.status, "ok", "the losing side of a tie must be left untouched");
});

test("#615: 40,000 client rows fold against 40,000 daemon rows in well under 2s", () => {
  const events = pairedEventSet(615, 40_000, 50);
  assert.equal(events.length, 80_000);

  const startMs = performance.now();
  const { folded } = foldClientDuplicates(events);
  const elapsedMs = performance.now() - startMs;

  // Measured on the reference host on this exact 80,000-row input: the
  // pre-#615 nested scan (`referenceFoldClientDuplicates` above) took ~96s;
  // the indexed version took ~0.7s. The bound below is kept well above the
  // measured value so a slower CI runner does not make this flaky — it is a
  // safety margin, not the claim; the claim is the ~96s-vs-~0.7s measurement.
  assert.ok(
    elapsedMs < 4000,
    `indexed fold took ${elapsedMs.toFixed(0)}ms for 80,000 events — expected well under 2s (measured ~700ms on the reference host)`,
  );
  assert.ok(folded > 30_000, "an ~85% pairing rate over 40,000 calls must fold most of them");
});
