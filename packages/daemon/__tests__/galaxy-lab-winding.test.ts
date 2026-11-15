/**
 * galaxy-lab does not wind itself up (#328).
 *
 * Every star used to get its own angular speed out of its own radius, which
 * makes the arms MATERIAL structures under differential rotation — and those
 * wind up. Measured on the shipped values: 180° of shear across one arm after
 * ~4 minutes, globulars and satellites smeared into arcs along with it. A
 * reload looked like a fix only because the clock is `performance.now()`.
 *
 * omega is a property of the STRUCTURE now. The property this pins is the one
 * that keeps distances: inside a zone, every member turns at exactly the same
 * rate. Asserted on the mechanism, not on a 30-minute stopwatch — but the
 * distance check below runs the real rotation for 30 minutes of model time.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/galaxy-lab-winding.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain browser module, no types (same as the map modules
// live-updates.test.ts and memory-counter.test.ts pull in).
import { milkyWayLayout, ROLE } from "../webui/js/managers/orbit-cosmos.js";

type Member = { id: string; sub?: string; group?: string };
type Entry = [string, Member[]];

const DISC_R = 1198; // the value the issue measured against (~670 nodes)
const HOLE_R = 40;
const SPIN = 0.0176; // rad/s, from the same measurement

function members(prefix: string, n: number, opts: Partial<Member> = {}): Member[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, ...opts }));
}

/** The four main arms plus a spur, a globular and an unadopted import. */
function vaultShape(): { entries: Entry[]; userKey: string } {
  const userKey = "me";
  const entries: Entry[] = [
    [userKey, members("user", 6)],
    // arm with two sub-area knots (>= 3 members each is what makes a knot)
    [
      "alpha",
      [
        ...members("alpha-core", 6),
        ...members("alpha-infra", 4, { sub: "infra" }),
        ...members("alpha-ui", 3, { sub: "ui" }),
      ],
    ],
    ["beta", members("beta", 8)],
    ["gamma", members("gamma", 7)],
    ["delta", members("delta", 6)],
    // 5th in-galaxy cluster with >= 5 members → spur
    ["epsilon", members("epsilon", 5)],
    // < 5 members → globular out in the halo
    ["zeta", members("zeta", 3)],
    // intake → satellite galaxy
    ["eta (import)", members("eta", 4, { group: "intake" })],
  ];
  return { entries, userKey };
}

function layout() {
  const { entries, userKey } = vaultShape();
  const plan = milkyWayLayout(entries, userKey, DISC_R, HOLE_R, false);
  const omegaOf = (id: string): number | undefined => plan.positions.get(id)?.omegaScale;
  const clusterFor = (key: string) => plan.clusters.find((c: { key: string }) => c.key === key);
  return { entries, plan, omegaOf, clusterFor };
}

/** The rotation the view applies per frame (orbit-view.js:463-466). */
function turn(p: { x: number; y: number; z: number }, omega: number, tSec: number) {
  const a = SPIN * omega * tSec;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos, z: p.z };
}

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test("the disc turns as one pattern — no star carries its own omega", () => {
  const { omegaOf } = layout();

  // arms, their knots, and the spur: all of them ride the disc, so none of
  // them may bring an omega of its own. Unset is the disc speed (view: ?? 1).
  const discStars = [
    "alpha-core-0",
    "alpha-core-5", // arm core, both ends
    "alpha-infra-0",
    "alpha-ui-2", // sub-area knots
    "beta-0",
    "gamma-3",
    "delta-5", // the other arms
    "epsilon-0",
    "epsilon-4", // the spur
  ];
  for (const id of discStars) {
    assert.equal(
      omegaOf(id),
      undefined,
      `${id} sits in the disc and must not carry its own omega — that is the winding bug`
    );
  }
});

test("a globular and a satellite each turn at ONE rate, slower than the disc", () => {
  const { omegaOf, clusterFor } = layout();

  for (const [prefix, key, role] of [
    ["zeta", "zeta", ROLE.HALO],
    ["eta", "eta (import)", ROLE.SATELLITE],
  ] as const) {
    const omegas = new Set(Array.from({ length: 3 }, (_, i) => omegaOf(`${prefix}-${i}`)));
    assert.equal(omegas.size, 1, `${key} must have ONE omega for all members, got ${[...omegas]}`);

    const omega = [...omegas][0]!;
    assert.ok(omega > 0 && omega < 1, `${key} is halo — it has to drift slower than the disc, got ${omega}`);

    // the label has to ride the structure it names, or it slides off it
    const c = clusterFor(key);
    assert.equal(c.role, role);
    assert.equal(c.omegaScale, omega, `${key}'s marker must carry its structure's omega`);
  }
});

test("the core still laps the disc", () => {
  const { omegaOf } = layout();
  const omega = omegaOf("user-0")!;
  assert.ok(omega > 1, `the user's accretion disc keeps its ACCRETION_SPEEDUP, got ${omega}`);
});

test("after 30 minutes every distance inside a structure is unchanged", () => {
  const { plan, omegaOf } = layout();
  const HALF_HOUR = 1800;
  const at = (id: string, t: number) => {
    const p = plan.positions.get(id)!;
    return turn(p, p.omegaScale ?? 1, t);
  };
  // A pair spanning one arm end to end — the pair the issue measured 180° of
  // shear on. Plus a globular, which used to be pulled into an arc.
  const pairs: [string, string][] = [
    ["alpha-core-0", "alpha-core-5"], // inner arm end ↔ outer arm end
    ["alpha-core-0", "alpha-ui-2"], // arm core ↔ its own knot
    ["alpha-core-0", "beta-0"], // across two arms
    ["zeta-0", "zeta-2"], // inside the globular
  ];
  for (const [a, b] of pairs) {
    const before = dist(at(a, 0), at(b, 0));
    const after = dist(at(a, HALF_HOUR), at(b, HALF_HOUR));
    assert.ok(
      Math.abs(after - before) < 1e-6,
      `${a}↔${b} drifted from ${before.toFixed(2)} to ${after.toFixed(2)} in 30 min`
    );
  }

  // …and the galaxy really did turn: this is not a "nothing moves" pass.
  const moved = dist(at("alpha-core-0", 0), at("alpha-core-0", HALF_HOUR));
  assert.ok(moved > 100, `the disc has to rotate, moved only ${moved.toFixed(1)}px`);

  // the halo drifts against the disc, which is the whole point of three zones
  assert.ok((omegaOf("zeta-0") ?? 1) < 1, "the globular has to fall behind the arms, not ride with them");
});
