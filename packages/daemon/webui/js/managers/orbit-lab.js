/** Universe construction for the two TEST modes — kept out of orbit-view.js so
 *  the shipped `universe` / `galaxy` build path stays exactly as it is (and so
 *  orbit-view.js stays under the file-size convention).
 *
 *  Both modes fill the SAME structures the shipped modes fill — universe.disc,
 *  universe.planets, universe.galaxies, universe.systems — so everything
 *  downstream (projection, depth sort, hover, supernovae, decor, labels) keeps
 *  working untouched. Only where the stars go is different.
 *
 *  universe-lab : cosmic web placement + Hubble-classified galaxies
 *  galaxy-lab   : ONE Milky Way, clusters as arms/spurs/halo/satellites
 */

import { classifyAll, morphLocal, morphRadius, KIND } from "./orbit-morph.js";
import { cosmicWebPlacement, milkyWayLayout, isIntakeCluster, ROLE } from "./orbit-cosmos.js";
import { GOLDEN, rnd } from "./orbit-galaxy.js";

/** Build one of the lab universes into `env.universe`.
 *  @param env {universe, entries, adj, R, mode, userKey, discBasis, tuning} */
export function buildLab(env) {
  return env.mode === "galaxy-lab" ? buildMilkyWay(env) : buildCosmicWeb(env);
}

// ───────────────────────────────────────────────────────────────────────────

function buildCosmicWeb(env) {
  const { universe, entries, adj, R, discBasis, tuning } = env;

  // Classify first: the morphology decides the radius, and the radius decides
  // the separation the web layout has to respect. classifyAll ranks the whole
  // vault at once — the disc types are relative, not absolute.
  const morphs = classifyAll(entries, isIntakeCluster);

  // Cap the disc radius against the universe scale — but generously. A tight
  // cap (the first pass used R * 0.2) shrinks the big spirals until their arms
  // are unreadable, which defeats the point. The separation is handled by the
  // web layout keeping the GLOWS apart, not by making the galaxies small.
  const capped = new Map();
  for (const [key, members] of entries) {
    const raw = morphRadius(morphs.get(key).kind, members.length);
    capped.set(key, Math.min(raw, R * 0.3));
  }

  const centers = cosmicWebPlacement(entries, env.edges, (k) => capped.get(k) ?? 60, R);

  entries.forEach(([key, members], ci) => {
    const morph = morphs.get(key);
    const discR = capped.get(key);
    const center = centers.get(key) ?? { px: 0, py: 0, pz: 0 };
    const basis = discBasis(ci + 1);
    const dwarf = morph.kind === KIND.GLOBULAR;
    const spin = tuning.DISC_SPIN * (0.4 + rnd(ci, 89) * 0.6) * (rnd(ci, 91) > 0.5 ? 1 : -1);

    // Nebulae belong ON the arms — that is where the gas is compressed and the
    // HII regions light up. The shipped mode scatters them at random offsets.
    const nebula =
      morph.arms > 0
        ? Array.from({ length: morph.arms }, (_, bi) => {
            const ang = (bi / morph.arms) * Math.PI * 2 - Math.log(2.4) / Math.tan(morph.pitch);
            const rr = discR * 0.62;
            return {
              ox: Math.cos(ang) * rr,
              oy: Math.sin(ang) * rr,
              r: discR * (0.34 + rnd(ci * 7 + bi, 107) * 0.3),
              phase: rnd(ci * 7 + bi, 109) * Math.PI * 2,
              drift: 0.05 + rnd(ci * 7 + bi, 113) * 0.1,
            };
          })
        : null;

    universe.galaxies.push({
      key,
      center,
      orbit: null,
      basis,
      r: discR,
      count: members.length,
      dwarf,
      nebula,
      spin,
      phase: rnd(ci, 151) * Math.PI * 2,
      morph,
      sx: 0,
      sy: 0,
      d: 0,
      scale: 1,
    });

    // Sub-areas become star-forming KNOTS on an arm — not a second spiral disc
    // on a satellite ring. That was the "two spirals for one project" bug:
    // bastra-io rendered its `admin` sub-folder (22 members) as a full second
    // galaxy, and `documents` rendered as one star plus a 29-member satellite.
    const { subs } = splitSubs(members);
    const regionOf = new Map();
    subs.forEach((s, si) => {
      const arm = morph.arms > 0 ? si % morph.arms : 0;
      const from = 0.2 + (si / Math.max(subs.length, 1)) * 0.6;
      const region = { arm, from, to: from + 0.18, total: s.members.length };
      for (const n of s.members) regionOf.set(n.id, region);
    });

    layoutMorph({
      universe,
      tuning,
      adj,
      members,
      regionOf,
      center,
      basis,
      discR,
      morph,
      spin,
      dwarf,
      seed: ci * 97 + 1,
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────

function buildMilkyWay(env) {
  const { universe, entries, adj, R, userKey, discBasis, tuning } = env;

  const discR = Math.min(R * 0.72, Math.max(700, Math.sqrt(countAll(entries)) * 62));
  // the core radius the view will draw, so the user's accretion disc clears it
  const plan = milkyWayLayout(entries, userKey, discR, Math.max(R * 0.035, 34), env.core === "gravity");

  // ONE galaxy, one plane. A modest tilt so the disc reads as a disc rather
  // than a flat ring, but every cluster shares it — there are no sub-galaxies
  // with their own orientation, because the Milky Way has none.
  const basis = discBasis(3);
  const origin = { px: 0, py: 0, pz: 0 };
  const spin = tuning.DISC_SPIN * 0.55;

  for (const [, members] of entries) {
    for (const n of members) {
      const p = plan.positions.get(n.id);
      if (!p) continue;
      // The star turns at the speed of the STRUCTURE it belongs to, and the
      // layout already decided that (#328): the user's ring brings the
      // accretion speed-up, halo structures bring their own omega, and a disc
      // star brings none — it rides the one pattern speed of the arms. Reading
      // an omega out of this star's own radius here is exactly what wound the
      // arms up, so nothing is derived at this point any more.
      universe.disc.set(n.id, {
        center: origin,
        ring: null,
        basis,
        x: p.x,
        y: p.y,
        z: p.z,
        spin,
        omegaScale: p.omegaScale,
        orbit3d: p.orbit3d,
      });
    }
  }

  // Cluster markers: labels + glow live on the arm's midpoint, so a project
  // gets named where it actually lies along its arm.
  //
  // `center` is a LIVE object the view mutates every frame (the same contract
  // the galactic mode's orbiting clouds use). It has to ride the disc rotation,
  // or after a couple of minutes every label has drifted off its own arm — and
  // keeping it a real world position means spawnBurst and the decor keep
  // working through `g.center` with no special case.
  for (const c of plan.clusters) {
    const w = env.inPlane({ px: 0, py: 0, pz: 0 }, basis, c.cx, c.cy, c.cz);
    universe.galaxies.push({
      key: c.key,
      center: { px: w.px, py: w.py, pz: w.pz },
      local: { x: c.cx, y: c.cy, z: c.cz },
      // the marker carries the omega of the structure it NAMES — the same one
      // its stars got from the layout — otherwise the label slides off its own
      // arm within a minute
      omegaScale: c.omegaScale,
      galaxyBasis: basis,
      orbit: null,
      basis,
      r: c.r,
      count: c.count,
      dwarf: c.role === ROLE.HALO,
      nebula: null,
      spin,
      role: c.role,
      phase: rnd(c.count, 151) * Math.PI * 2,
      sx: 0,
      sy: 0,
      d: 0,
      scale: 1,
    });
  }

  // Solar systems still make sense inside one galaxy — a hub memory with its
  // satellites is a star with planets, at whatever point of the arm it sits.
  attachSystems({ universe, tuning, adj, basis, spin, entries, seed: 11 });
}

const countAll = (entries) => entries.reduce((s, [, m]) => s + m.length, 0);

// ───────────────────────────────────────────────────────────────────────────

function splitSubs(members) {
  const bySub = new Map();
  for (const n of members) {
    const s = n.sub && n.sub !== "general" ? n.sub : "";
    const l = bySub.get(s) ?? [];
    l.push(n);
    bySub.set(s, l);
  }
  const subs = [];
  for (const [k, v] of bySub) if (k !== "" && v.length >= 3) subs.push({ key: k, members: v });
  const claimed = new Set(subs.flatMap((s) => s.members));
  return { subs, core: members.filter((n) => !claimed.has(n)) };
}

/** Place one classified galaxy's members, mirroring layoutDisc's contract:
 *  hubs become suns with orbiting planets, everything else lands in the disc. */
function layoutMorph(o) {
  const { universe, tuning, adj, members, regionOf, center, basis, discR, morph, spin, dwarf, seed } = o;
  const claimed = new Set();
  const memberSet = new Set(members);

  const suns = dwarf
    ? []
    : members
        .filter((n) => (n.degree ?? 0) >= tuning.SUN_DEGREE)
        .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
        .slice(0, Math.max(1, Math.floor(Math.sqrt(members.length) / 1.6)));

  for (const sun of suns) {
    const sats = (adj.get(sun.id) ?? [])
      .filter((m) => memberSet.has(m) && !claimed.has(m.id) && m !== sun && (m.degree ?? 0) <= tuning.PLANET_DEGREE)
      .slice(0, tuning.MAX_PLANETS);
    if (sats.length < 2) continue;
    claimed.add(sun.id);
    const local = morphLocal(morph, discR, claimed.size * 7 + seed, 0.3 + rnd(seed + claimed.size, 31) * 0.5, spin);
    universe.disc.set(sun.id, { center, ring: null, basis, ...local, spin });
    const rings = [];
    sats.forEach((p, pi) => {
      claimed.add(p.id);
      const orbitR = tuning.ORBIT_BASE + pi * tuning.ORBIT_STEP;
      rings.push(orbitR);
      universe.planets.set(p.id, {
        sunId: sun.id,
        basis,
        orbitR,
        phase: pi * GOLDEN + rnd(seed + pi, 37) * Math.PI * 2,
        omega: (tuning.OMEGA / Math.pow(orbitR / tuning.ORBIT_BASE, 1.5)) * (rnd(seed + pi, 41) > 0.5 ? 1 : -1),
      });
    });
    universe.systems.push({
      sunId: sun.id,
      basis,
      rings,
      pulse: rnd(seed, 167) * Math.PI * 2,
      sunWorld: null,
      sx: 0,
      sy: 0,
      d: 0,
      scale: 1,
    });
  }

  const field = members.filter((n) => !claimed.has(n.id));
  // A sub-area's members need t to run 0→1 WITHIN their own knot, so the knot
  // stays a contiguous stretch of arm. Everyone else spreads over the disc.
  const seenInRegion = new Map();
  const plainCount = field.filter((n) => !regionOf.has(n.id)).length;
  let plainIdx = 0;
  field.forEach((n, i) => {
    const region = regionOf.get(n.id) ?? null;
    let t;
    if (region) {
      const rk = `${region.arm}:${region.from}`;
      const seen = seenInRegion.get(rk) ?? 0;
      seenInRegion.set(rk, seen + 1);
      t = (seen + 0.5) / Math.max(region.total, 1);
    } else {
      t = (plainIdx++ + 0.5) / Math.max(plainCount, 1);
    }
    const local = morphLocal(morph, discR, i + seed, t, spin, region);
    universe.disc.set(n.id, { center, ring: null, basis, ...local, spin });
  });
}

/** Hub → sun + planets, for the single-galaxy mode where positions are already
 *  fixed by the arm layout. Only the planets move into orbits. */
function attachSystems(o) {
  const { universe, tuning, adj, basis, seed } = o;
  const claimed = new Set();
  const all = o.entries.flatMap(([, m]) => m);
  const byId = new Map(all.map((n) => [n.id, n]));

  const suns = all
    .filter((n) => (n.degree ?? 0) >= tuning.SUN_DEGREE)
    .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
    .slice(0, Math.max(4, Math.round(Math.sqrt(all.length))));

  for (const sun of suns) {
    if (!universe.disc.has(sun.id)) continue;
    const sats = (adj.get(sun.id) ?? [])
      .filter((m) => byId.has(m.id) && !claimed.has(m.id) && m !== sun && (m.degree ?? 0) <= tuning.PLANET_DEGREE)
      .slice(0, tuning.MAX_PLANETS);
    if (sats.length < 2) continue;
    claimed.add(sun.id);
    const rings = [];
    sats.forEach((p, pi) => {
      claimed.add(p.id);
      universe.disc.delete(p.id); // it becomes a planet, not a disc star
      const orbitR = tuning.ORBIT_BASE + pi * tuning.ORBIT_STEP;
      rings.push(orbitR);
      universe.planets.set(p.id, {
        sunId: sun.id,
        basis,
        orbitR,
        phase: pi * GOLDEN + rnd(seed + pi, 37) * Math.PI * 2,
        omega: (tuning.OMEGA / Math.pow(orbitR / tuning.ORBIT_BASE, 1.5)) * (rnd(seed + pi, 41) > 0.5 ? 1 : -1),
      });
    });
    universe.systems.push({
      sunId: sun.id,
      basis,
      rings,
      pulse: rnd(seed, 167) * Math.PI * 2,
      sunWorld: null,
      sx: 0,
      sy: 0,
      d: 0,
      scale: 1,
    });
  }
}
