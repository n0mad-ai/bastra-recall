/**
 * computeHeat — die Nachfrage-Uhr hat einen Zeitterm (#227).
 *
 * Gemeldet von zzallirog: `foldEvent` schreibt `last_*_at` seit jeher, und
 * `computeHeat` las nur die Zähler. Ein vor einem Jahr fünfzigmal erreichtes
 * Memory schlug damit dauerhaft eines, das diese Woche dreimal dran war —
 * für eine Uhr, die Nachfrage messen soll, ist das verkehrt herum.
 *
 * Der Zeitterm wirkt bewusst asymmetrisch: bei gleich alten Kandidaten ändert
 * er die Reihenfolge NICHT (er skaliert alle um denselben Faktor), bei
 * altersgemischten kippt er sie. Beide Fälle stehen hier.
 *
 * Runner: `tsx --test __tests__/usage-heat-decay.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHeat, type UsageAggregate } from "../src/usage-sidecar.js";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();

function entry(loaded: number, acted: number, ageDays: number | null): UsageAggregate[string] {
  return {
    surfaced: 0,
    loaded,
    acted_on: acted,
    ...(ageDays === null ? {} : { last_loaded_at: daysAgo(ageDays) }),
  };
}

test("same weight, different age: the fresher memory ranks higher", () => {
  const heat = computeHeat(
    { fresh: entry(6, 0, 1), stale: entry(6, 0, 40) },
    NOW,
  );
  assert.ok(heat.fresh > heat.stale, "a clock that ignores time is not a clock");
  assert.equal(heat.fresh, 1, "the freshest of equals is the reference point");
});

test("a heavy but cold memory loses to a light warm one — the reported inversion", () => {
  // 50 Ladungen vor einem Jahr gegen 3 in dieser Woche.
  const heat = computeHeat({ lastYear: entry(50, 0, 365), thisWeek: entry(3, 0, 3) }, NOW);
  assert.ok(
    heat.thisWeek > heat.lastYear,
    "reached fifty times last year must not outrank three times this week",
  );
});

test("uniformly fresh contenders keep their order — decay is inert there", () => {
  // Der Fall dieses Vaults: die ganze Spitzengruppe ist gleich jung, also
  // skaliert der Term alle um denselben Faktor und die Rangfolge überlebt.
  const sameDay: UsageAggregate = {
    a: entry(10, 6, 0.7),
    b: entry(7, 6, 0.6),
    c: entry(13, 2, 0.7),
  };
  const withTime = computeHeat(sameDay, NOW);
  const order = Object.entries(withTime).sort((x, y) => y[1] - x[1]).map(([id]) => id);
  // #469: weight is `loaded` alone (13 > 10 > 7) — before, 2 × acted_on
  // lifted a and b above c.
  assert.deepEqual(order, ["c", "a", "b"], "weight still decides among equals in age");
});

test("#469: acted_on no longer weighs — only loads make heat", () => {
  const heat = computeHeat({ applied: entry(3, 3, 1), opened: entry(3, 0, 1) }, NOW);
  assert.equal(heat.applied, heat.opened, "three acted_on episodes on top of three loads change nothing");
  assert.deepEqual(computeHeat({ onlyActed: entry(0, 5, 1) }, NOW), {}, "acted_on without a load is no heat");
});

test("a memory without timestamps is not demoted for our bookkeeping", () => {
  // Einträge aus der Zeit vor den Stempeln dürfen nicht bestraft werden:
  // fehlender Stempel heißt „wir wissen es nicht", nicht „lange her".
  const heat = computeHeat({ noStamp: entry(6, 0, null), old: entry(6, 0, 40) }, NOW);
  assert.equal(heat.noStamp, 1);
  assert.ok(heat.noStamp > heat.old);
});

test("an empty or never-reached vault yields no heat at all", () => {
  assert.deepEqual(computeHeat({}, NOW), {});
  assert.deepEqual(computeHeat({ untouched: entry(0, 0, 1) }, NOW), {});
});
