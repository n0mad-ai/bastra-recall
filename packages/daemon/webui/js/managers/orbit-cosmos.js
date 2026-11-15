/** Placement for the Mindspace TEST modes — pure layout math, no view state.
 *  The shipped `universe` and `galaxy` modes do not call anything in here.
 *
 *  Two layouts, one per test mode:
 *
 *  ── cosmicWebPlacement (universe-lab) ────────────────────────────────────
 *  The shipped universe scatters cluster centres by farthest-point sampling in
 *  a random ellipsoid: the position is pure anti-overlap spacing and carries no
 *  information at all. Distance between two galaxies means nothing, and the
 *  2672 cross-cluster edges never enter the layout. (It also has a quirk: the
 *  first centre is scored by distance from the origin, so the LARGEST cluster
 *  is systematically pushed to the rim and the middle stays empty.)
 *
 *  Here the bridges do the work. A 3D force relaxation pulls clusters together
 *  along their shared edges and pushes everything else apart, so projects that
 *  actually reference each other end up as neighbours. Filaments and voids fall
 *  out of that on their own — which is what the real cosmic web is: mass
 *  tracing its own gravity, not a uniform sprinkle.
 *
 *  ── milkyWayLayout (galaxy-lab) ──────────────────────────────────────────
 *  The shipped galactic mode puts the user at the centre as a black hole and
 *  then orbits OTHER GALAXIES around it — and inside each of those, every
 *  sub-folder with >=3 members becomes yet another full spiral disc on a
 *  satellite ring. bastra-io renders as three separate spirals for one project;
 *  `documents` renders as one lone star plus a 29-member satellite.
 *
 *  That is not what a galaxy is. The Milky Way has no sub-galaxies. It has a
 *  central black hole, a bar, four main arms, spurs between them, globular
 *  clusters in the halo, and a couple of satellite galaxies falling in. So:
 *
 *    Sgr A*            → the user
 *    bulge             → the memories about the user
 *    main arms         → the big projects
 *    spurs             → mid-size areas (the Orion Spur is exactly this)
 *    star-forming knot → a sub-area, sitting ON its project's arm
 *    globular clusters → small areas, in the halo
 *    satellite galaxies→ intake / imports, not yet woven in
 *
 *  Everything lives in ONE disc. Nothing orbits as a second galaxy.
 */

import { rnd } from "./orbit-galaxy.js";
import { morphLocal, classifyGalaxy, accretionLocal, gravityWebLocal } from "./orbit-morph.js";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Angular speed at radius r, from a real disc-galaxy rotation curve.
 *
 *  NOT Kepler. Kepler (omega ~ r^-1.5) only holds when nearly all the mass sits
 *  at the centre — true for an accretion disc, wrong for a galaxy, where the
 *  mass is spread through the disc and halo. The first attempt used it and the
 *  result was exactly what that implies: the middle spun far too fast while the
 *  outskirts barely moved.
 *
 *  A real galaxy's curve has two parts:
 *    r < rTurn : solid-body — the inner region turns as one piece, omega flat
 *    r > rTurn : FLAT rotation curve, v constant, so omega ~ 1/r
 *
 *  That is what makes the centre quicker than the rim without the rim standing
 *  still, and it is why the user's ring — sitting deep inside, near the hole —
 *  laps the arms.
 *
 *  @returns a multiplier normalised to 1 at rTurn */
export function galacticOmega(r, rTurn) {
  return r <= rTurn ? 1 : rTurn / Math.max(r, 1);
}

/** Is this cluster an unadopted import? Same test the shipped mode uses. */
export const isIntakeCluster = (key, members) => members[0]?.group === "intake" || / \(import\)$/.test(key);

// ───────────────────────────────────────────────────────────────────────────
// universe-lab: the cosmic web
// ───────────────────────────────────────────────────────────────────────────

/** @param entries    [key, members][]
 *  @param edges      sim edges ({s, t} node refs)
 *  @param radiusOf   key → disc radius (for the minimum separation)
 *  @param R          universe scale
 *  @returns Map key → {px, py, pz} */
export function cosmicWebPlacement(entries, edges, radiusOf, R) {
  const N = entries.length;
  const idx = new Map(entries.map(([k], i) => [k, i]));
  const out = new Map();
  if (!N) return out;

  // cluster ↔ cluster edge mass
  const clusterOf = (n) => n.baseCluster ?? n.cluster;
  const w = new Map();
  for (const e of edges) {
    const a = idx.get(clusterOf(e.s));
    const b = idx.get(clusterOf(e.t));
    if (a === undefined || b === undefined || a === b) continue;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    w.set(k, (w.get(k) ?? 0) + 1);
  }
  const all = [...w.entries()].map(([k, v]) => {
    const [a, b] = k.split(":").map(Number);
    return { a, b, w: v };
  });
  const links = all;
  const maxW = links.reduce((m, l) => Math.max(m, l.w), 1);

  // deterministic start: Fibonacci sphere, so a rebuild lands in the same
  // basin instead of reshuffling the whole map on every live update
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const p = entries.map((_, i) => {
    const y = 1 - (2 * (i + 0.5)) / N;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * GOLDEN_ANGLE;
    const shell = R * (0.55 + rnd(i, 701) * 0.5);
    return { px: Math.cos(th) * rr * shell, py: y * shell * 0.62, pz: Math.sin(th) * rr * shell };
  });

  const rad = entries.map(([k]) => radiusOf(k));
  // heavier clusters move less — the big ones anchor the web
  const inv = entries.map(([, m]) => 1 / Math.max(1, Math.sqrt(m.length)));

  const iters = Math.max(140, Math.min(420, Math.round(9000 / Math.max(N, 1))));
  for (let step = 0; step < iters; step++) {
    const cool = 1 - step / iters;
    const fx = new Float64Array(N);
    const fy = new Float64Array(N);
    const fz = new Float64Array(N);

    // attraction along shared bridges
    for (const l of links) {
      const dx = p[l.b].px - p[l.a].px;
      const dy = p[l.b].py - p[l.a].py;
      const dz = p[l.b].pz - p[l.a].pz;
      const d = Math.hypot(dx, dy, dz) || 1;
      // Linked clusters have to end up VISIBLY closer, or the layout carries
      // information nobody can read: the first pass separated them by only
      // 1.2x, which is invisible against the size spread. The rest length sits
      // just above touching and the pull is strong enough to beat the ambient
      // repulsion.
      // Rest length: just clear of touching, plus a gap that shrinks with
      // bridge strength. Deliberately NOT scaled by the galaxy radii — those
      // vary by a factor of ten here, so folding them into the target distance
      // would drown the linkage signal in size noise. The radii only set the
      // floor (don't overlap); the STRENGTH sets the spacing.
      //
      // The gap term stays SMALL for a reason that cost a round of tuning:
      // unlinked pairs feel repulsion only, so they settle at the repulsion
      // equilibrium. If a weak link's rest length exceeds that, the spring
      // pushes weakly-linked pairs FURTHER APART than unlinked ones and the
      // whole signal inverts. Rest length must stay inside that equilibrium.
      // The floor is the GLOW radius, not the disc radius: orbit-decor draws a
      // galaxy's wash at r * 2.3, so discs that merely don't touch still bleed
      // into one another and read as a single smear. Separating the discs was
      // not enough — the light has to clear too.
      const strength = Math.min(l.w / maxW, 1);
      const floor = (rad[l.a] + rad[l.b]) * 2.5;
      const rest = floor + (1 - strength) * R * 0.14;
      const pull = ((d - rest) / d) * 0.18 * (0.35 + strength * 0.65);
      fx[l.a] += dx * pull;
      fy[l.a] += dy * pull;
      fz[l.a] += dz * pull;
      fx[l.b] -= dx * pull;
      fy[l.b] -= dy * pull;
      fz[l.b] -= dz * pull;
    }

    // repulsion everywhere — this is what opens the voids
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = p[j].px - p[i].px;
        let dy = p[j].py - p[i].py;
        let dz = p[j].pz - p[i].pz;
        let d = Math.hypot(dx, dy, dz);
        if (d < 1e-3) {
          dx = rnd(i * 31 + j, 709) - 0.5;
          dy = rnd(i * 31 + j, 719) - 0.5;
          dz = rnd(i * 31 + j, 727) - 0.5;
          d = 1;
        }
        const gap = (rad[i] + rad[j]) * 2.5 + 120;
        // hard separation while overlapping, soft 1/r falloff beyond. The
        // ambient term stays weak so it opens voids without flattening the
        // distance signal the bridges encode.
        const push = d < gap ? (gap - d) * 0.5 : ((gap * gap) / (d * d)) * 2.2;
        const ux = (dx / d) * push;
        const uy = (dy / d) * push;
        const uz = (dz / d) * push;
        fx[i] -= ux;
        fy[i] -= uy;
        fz[i] -= uz;
        fx[j] += ux;
        fy[j] += uy;
        fz[j] += uz;
      }
    }

    for (let i = 0; i < N; i++) {
      // weak pull to the origin so the web stays framed, plus a mild vertical
      // squash: the real web is filamentary, not a ball
      const damp = inv[i] * cool;
      p[i].px += (fx[i] - p[i].px * 0.012) * damp;
      p[i].py += (fy[i] - p[i].py * 0.03) * damp;
      p[i].pz += (fz[i] - p[i].pz * 0.012) * damp;
    }
  }

  entries.forEach(([k], i) => out.set(k, p[i]));
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// galaxy-lab: one Milky Way
// ───────────────────────────────────────────────────────────────────────────

export const ROLE = {
  BULGE: "bulge",
  ARM: "arm",
  SPUR: "spur",
  HALO: "halo",
  SATELLITE: "satellite",
};

export const ROLE_LABEL = {
  [ROLE.BULGE]: "Bulge",
  [ROLE.ARM]: "Arm",
  [ROLE.SPUR]: "Sporn",
  [ROLE.HALO]: "Kugelsternhaufen",
  [ROLE.SATELLITE]: "Satellitengalaxie",
};

const MAIN_ARMS = 4; // the Milky Way's count: Perseus, Norma, Scutum-Cen, Sgr-Car
const PITCH = 12.5 * DEG; // measured pitch of our own arms

/** Where the arms start — the bar ends here, exactly as in a real SBbc. */
const BAR_FRAC = 0.26;

/** Assign every cluster a role in one galaxy, then place every member star.
 *
 *  @param entries   [key, members][]  (already size-sorted by the caller)
 *  @param userKey   the cluster that becomes the bulge
 *  @param discR     radius of the galactic disc
 *  @param holeR     core radius — the accretion disc must clear it
 *  @param webMode   gravity-web core active: the user's memories ride their own
 *                   ellipses so the web's threads vary in length (see
 *                   gravityWebLocal); otherwise they form the plain ring
 *  @returns {positions: Map<nodeId,{x,y,z}>, clusters: [...], discR}
 *           positions are in the galaxy's own disc frame. */
export function milkyWayLayout(entries, userKey, discR, holeR = null, webMode = false) {
  const positions = new Map();
  const clusters = [];

  const rest = entries.filter(([k]) => k !== userKey);
  const satellites = rest.filter(([k, m]) => isIntakeCluster(k, m));
  const inGalaxy = rest.filter(([k, m]) => !isIntakeCluster(k, m));

  // Role by size: the big projects earn the main arms, mid-size areas become
  // spurs, small ones are globular clusters out in the halo.
  const armCount = Math.min(MAIN_ARMS, Math.max(1, inGalaxy.length));
  const arms = inGalaxy.slice(0, armCount);
  const remainder = inGalaxy.slice(armCount);
  const spurs = remainder.filter(([, m]) => m.length >= 5);
  const halo = remainder.filter(([, m]) => m.length < 5);

  const aMin = discR * BAR_FRAC;
  // Where the rotation curve flattens. Only halo structures are placed by it
  // now (see below); it sits just past the bar, so anything outside the disc
  // is guaranteed slower than the disc itself.
  const rTurn = discR * 0.25;
  // omegaScale is a property of the STRUCTURE, not of the single star (#328).
  // Handing every star its own omega out of its own radius makes the arms
  // MATERIAL structures under differential rotation, and those wind up within
  // a few turns — measured here: 180° of shear across one arm after ~4 min,
  // and every knot and globular smeared into an arc along with it. Real spiral
  // arms are a density wave with ONE pattern speed, which is why the shipped
  // galaxy disc turns rigidly on purpose. Three zones, and inside a zone
  // everything turns at exactly the same rate, so every distance holds:
  //   core  — the user's accretion disc keeps its own ACCRETION_SPEEDUP
  //   disc  — arms, spurs, knots: one pattern speed (omegaScale unset → 1)
  //   halo  — globulars and satellites: galacticOmega once per structure
  const push = (n, x, y, z, omegaScale) => positions.set(n.id, { x, y, z, omegaScale });
  const acc = [];

  // ── the user: an accretion disc AROUND Sgr A*, not a bulge inside it.
  // A spheroid centred on the origin put the user's closest memories inside
  // the event horizon, where nothing can be. See accretionLocal.
  const userMembers = entries.find(([k]) => k === userKey)?.[1] ?? [];
  const coreR = holeR ?? discR * 0.05;
  const inner = coreR * 1.5;
  const outer = Math.max(inner * 3.4, discR * 0.2);
  userMembers.forEach((n, i) => {
    const l = webMode
      ? gravityWebLocal(i, inner, outer)
      : accretionLocal(i, (i + 0.5) / userMembers.length, inner, outer);
    // omegaScale and orbit3d ride along: the view needs them to turn these
    // faster than the galaxy, and to evaluate the ellipses per frame.
    positions.set(n.id, { x: l.x, y: l.y, z: l.z, omegaScale: l.omegaScale, orbit3d: l.orbit3d });
  });
  if (userMembers.length) {
    clusters.push({ key: userKey, role: ROLE.BULGE, cx: 0, cy: 0, cz: 0, r: outer, count: userMembers.length });
  }

  // ── main arms: one project per arm, its sub-areas as knots along it
  arms.forEach(([key, members], k) => {
    const phase = (k / armCount) * TAU;
    const { sub, core } = splitSubs(members);
    // sub-areas take contiguous stretches of the arm; the core fills the rest
    const knots = sub.map((s, si) => {
      const from = 0.18 + (si / Math.max(sub.length, 1)) * 0.62;
      return { key: s.key, members: s.members, from, to: from + 0.17 };
    });
    core.forEach((n, i) => {
      const t = (i + 0.5) / Math.max(core.length, 1);
      const pt = armPoint(discR, aMin, phase, t, i, 0.085);
      push(n, pt.x, pt.y, pt.z);
      acc.push(pt);
    });
    for (const kn of knots) {
      kn.members.forEach((n, i) => {
        const t = kn.from + (kn.to - kn.from) * ((i + 0.5) / kn.members.length);
        // a star-forming knot is tight and sits ON the ridge
        const pt = armPoint(discR, aMin, phase, t, i * 7 + 3, 0.03);
        push(n, pt.x, pt.y, pt.z);
      });
    }
    const mid = armPoint(discR, aMin, phase, 0.55, 1, 0);
    clusters.push({ key, role: ROLE.ARM, cx: mid.x, cy: mid.y, cz: mid.z, r: discR * 0.3, count: members.length });
  });

  // ── spurs: short bridges between the main arms, like the Orion Spur
  spurs.forEach(([key, members], si) => {
    const phase = ((si + 0.5) / Math.max(spurs.length, 1)) * TAU + 0.4;
    const t0 = 0.34 + rnd(si, 751) * 0.3;
    members.forEach((n, i) => {
      const t = t0 + ((i + 0.5) / members.length) * 0.16;
      const pt = armPoint(discR, aMin, phase, t, i * 3 + si, 0.05);
      push(n, pt.x, pt.y, pt.z);
    });
    const mid = armPoint(discR, aMin, phase, t0 + 0.08, si, 0);
    clusters.push({ key, role: ROLE.SPUR, cx: mid.x, cy: mid.y, cz: mid.z, r: discR * 0.14, count: members.length });
  });

  // ── halo: globular clusters, spherical, off the plane
  //
  // Astronomically these belong FAR out — the Milky Way's globulars reach past
  // six disc radii. The first pass used 1.15…2.3x on that reasoning, and it
  // was wrong for this map: these are the 1-3 memory folders, so the rule
  // banished the smallest, hardest-to-find things in the vault to the edge of
  // the frame where they read as stray dots rather than as part of the galaxy.
  // Pulled in to just outside the disc: still visibly halo, still findable.
  halo.forEach(([key, members], hi) => {
    const shell = discR * (1.02 + rnd(hi, 757) * 0.4);
    const th = rnd(hi, 761) * TAU;
    const ph = Math.acos(2 * rnd(hi, 769) - 1);
    const sp = Math.sin(ph);
    const cx = sp * Math.cos(th) * shell;
    const cy = sp * Math.sin(th) * shell;
    const cz = Math.cos(ph) * shell;
    const spread = Math.max(22, Math.sqrt(members.length) * 15);
    // ONE omega for the whole globular, from the SHELL it sits on — not from
    // each member, and not from the projected radius hypot(cx,cy). A globular
    // parked near the rotation axis has a projected radius of almost nothing
    // and would run at full solid-body speed while an equally distant one in
    // the plane crawls: the halo would de-mix. The shell is the real distance
    // from the centre, and it is always > discR > rTurn, so every halo
    // structure is guaranteed slower than the disc.
    const omega = galacticOmega(shell, rTurn);
    members.forEach((n, i) => {
      const u = rnd(i + hi * 13, 773);
      const rr = spread * u * u;
      const t2 = rnd(i + hi * 13, 787) * TAU;
      const p2 = Math.acos(2 * rnd(i + hi * 13, 797) - 1);
      const s2 = Math.sin(p2);
      push(n, cx + s2 * Math.cos(t2) * rr, cy + s2 * Math.sin(t2) * rr, cz + Math.cos(p2) * rr, omega);
    });
    clusters.push({ key, role: ROLE.HALO, cx, cy, cz, r: spread, count: members.length, omegaScale: omega });
  });

  // ── satellites: unadopted imports, irregular, falling in from outside
  satellites.forEach(([key, members], si) => {
    // Satellites stay further out than the halo — they are not part of this
    // galaxy yet — but same correction: close enough to stay on screen.
    const shell = discR * (1.55 + rnd(si, 809) * 0.5);
    const th = rnd(si, 811) * TAU;
    const ph = Math.acos(2 * rnd(si, 821) - 1) * 0.7 + 0.4;
    const sp = Math.sin(ph);
    const cx = sp * Math.cos(th) * shell;
    const cy = sp * Math.sin(th) * shell;
    const cz = Math.cos(ph) * shell;
    const morph = classifyGalaxy(key, members, true, si + 1);
    const rr = Math.max(45, Math.sqrt(members.length) * 20);
    // same rule as the globulars: one omega for the whole satellite, from its
    // shell — a satellite that shears itself apart stops being a galaxy.
    const omega = galacticOmega(shell, rTurn);
    members.forEach((n, i) => {
      const t = (i + 0.5) / members.length;
      const l = morphLocal(morph, rr, i + si * 17, t, 1);
      push(n, cx + l.x, cy + l.y, cz + l.z, omega);
    });
    clusters.push({ key, role: ROLE.SATELLITE, cx, cy, cz, r: rr, count: members.length, omegaScale: omega });
  });

  return { positions, clusters, discR, aMin };
}

/** Sub-folders with enough members to read as their own knot. */
function splitSubs(members) {
  const bySub = new Map();
  for (const n of members) {
    const s = n.sub && n.sub !== "general" ? n.sub : "";
    const l = bySub.get(s) ?? [];
    l.push(n);
    bySub.set(s, l);
  }
  const sub = [];
  for (const [k, v] of bySub) if (k !== "" && v.length >= 3) sub.push({ key: k, members: v });
  const claimed = new Set(sub.flatMap((s) => s.members));
  return { sub, core: members.filter((n) => !claimed.has(n)) };
}

/** A point on a trailing logarithmic arm at fraction t along it.
 *
 *  The scatter is applied PERPENDICULAR to the arm ridge, decomposed into a
 *  radial and a tangential part via the pitch angle — so the arm keeps the same
 *  width from hub to rim. Scattering in the angle (what the shipped mode does)
 *  makes arms razor-thin in the centre and fans them out at the edge.
 *
 *  Sign: the galaxy spins one way in worldPos, and the winding has to move the
 *  angle the other way or the arms lead the rotation (#283). */
function armPoint(discR, aMin, phase, t, i, widthFrac) {
  const s = Math.min(Math.max(t, 0), 1);
  const a = aMin + (discR - aMin) * Math.pow(s, 0.88);
  const twist = -(Math.log(a / aMin) / Math.tan(PITCH));
  const width = discR * widthFrac;
  const off = width ? (rnd(i, 823) + rnd(i, 827) - 1) * width : 0;
  const r = a + off * Math.cos(PITCH);
  const ang = twist + phase + (off * Math.sin(PITCH)) / Math.max(a, 1);
  // thin, flaring disc
  const hz = discR * 0.028 * (1 + (a / discR) * 1.8);
  return {
    x: Math.cos(ang) * r,
    y: Math.sin(ang) * r,
    z: (rnd(i, 829) + rnd(i, 839) - 1) * hz,
  };
}
