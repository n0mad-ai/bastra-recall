/** Galaxy morphology for the Mindspace TEST modes (universe-lab, galaxy-lab).
 *
 *  Nothing in here touches the two shipped modes: `universe` and `galaxy` keep
 *  spiralLocal() in orbit-view.js byte for byte. This file answers two things
 *  those modes get wrong.
 *
 *  1) EVERY non-dwarf cluster rendered the same two-armed spiral (`arm = i % 2`),
 *     so ten projects looked interchangeable.
 *  2) The shape carried no information — arms, tilt and nebulae were all rnd().
 *
 *  The fix hangs the whole Hubble sequence off ONE measured property of a
 *  cluster: its degree concentration, i.e. how much of the cluster's edge mass
 *  hangs off its few biggest hubs. That is not a decorative choice, it is the
 *  actual astrophysics — arm count is driven by central concentration, not by
 *  size. A big bulge stabilises the m=2 density wave (the same condition that
 *  produces a bar), so grand-design two-armed spirals are the CONCENTRATED
 *  ones; low-concentration discs go multi-armed and flocculent. Euclid measures
 *  2-armed at ~60-70% of spirals with the LARGER concentration and 3-armed at
 *  ~15-20% with the smaller, at fixed stellar mass.
 *
 *  So a hub-dominated project genuinely is a barred grand design and a flat one
 *  genuinely is a four-armed Sd. The form is readable AND correct.
 *
 *  Star positions come from the density-wave picture (Lindblad; Ingo Berg's
 *  galaxy renderer uses the same construction): stars ride closed orbits whose
 *  apsides precess with radius. An m-mode perturbation of a circular orbit
 *
 *      r(phi) = a * (1 + e * cos(m * (phi - Omega(a)))),  Omega(a) ~ ln a
 *
 *  makes the arms EMERGE as the crowding of neighbouring orbits instead of
 *  being painted on. Stars stay uniform in phi, so the inter-arm disc fills
 *  itself — which is what a real galaxy looks like: arms are roughly a 2x
 *  density enhancement over a full disc, not two stripes with a void between.
 *
 *  Omega(a) ~ ln a is a logarithmic spiral, so the pitch angle is constant with
 *  radius (the old code used a linear `t * 3.6`, an Archimedean spiral that
 *  wound about half a turn and read as two bent bananas).
 *
 *  Determinism: every random draw goes through rnd(i, salt) from orbit-galaxy,
 *  never Math.random — positions have to be stable across rebuilds, or the
 *  whole map would reshuffle on every live update.
 */

import { rnd } from "./orbit-galaxy.js";

/** Below this a cluster is a star cluster, not a galaxy — no disc, no arms. */
export const GLOBULAR_MAX = 4;

export const KIND = {
  GLOBULAR: "globular",
  ELLIPTICAL: "E",
  LENTICULAR: "S0",
  BARRED: "SB",
  SPIRAL: "S",
  FLOCCULENT: "Sd",
  IRREGULAR: "Irr",
};

/** Human-readable type for the inspector / label suffix. */
export const KIND_LABEL = {
  [KIND.GLOBULAR]: "Kugelsternhaufen",
  [KIND.ELLIPTICAL]: "elliptisch",
  [KIND.LENTICULAR]: "linsenförmig",
  [KIND.BARRED]: "Balkenspirale",
  [KIND.SPIRAL]: "Spirale",
  [KIND.FLOCCULENT]: "flockig",
  [KIND.IRREGULAR]: "irregulär",
};

/** Central concentration = the Gini coefficient of the cluster's degree
 *  distribution. 0 means every memory carries the same number of links, 1 means
 *  a single hub carries all of them.
 *
 *  The first attempt summed the edge mass of the sqrt(n) biggest hubs, which
 *  looks reasonable and is not: the statistic's behaviour depends on n, so a
 *  7-member cluster scored 0.66 and a 255-member one scored 0.12. That made
 *  small folders barred grand designs and the two biggest projects flocculent —
 *  exactly backwards. Gini is scale-free; measured over this vault it spreads
 *  0.22 … 0.58 with no size correlation. */
function concentration(members) {
  const n = members.length;
  if (n < 3) return 0;
  const v = members.map((m) => m.degree ?? 0).sort((a, b) => a - b);
  const total = v.reduce((s, d) => s + d, 0);
  if (total <= 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return Math.min(Math.max(cum / (n * total), 0), 1);
}

const DEG = Math.PI / 180;

/** The disc types, ordered from most to least centrally concentrated. Arm count
 *  rises and pitch angle opens as concentration falls — that IS the observed
 *  relation, not a stylistic ramp. */
const SEQUENCE = [
  { kind: KIND.BARRED, arms: 2, pitch: 13 * DEG, ecc: 0.26, bulge: 0.24, bar: 0.34 },
  { kind: KIND.SPIRAL, arms: 2, pitch: 18 * DEG, ecc: 0.24, bulge: 0.17 },
  { kind: KIND.SPIRAL, arms: 3, pitch: 23 * DEG, ecc: 0.21, bulge: 0.11 },
  { kind: KIND.FLOCCULENT, arms: 4, pitch: 29 * DEG, ecc: 0.17, bulge: 0.06 },
  { kind: KIND.FLOCCULENT, arms: 5, pitch: 34 * DEG, ecc: 0.14, bulge: 0.04 },
];

/** Classify a cluster on its own. Only the context-free cases are decided here
 *  — the disc types need to know the rest of the vault (see classifyAll). */
export function classifyGalaxy(key, members, intake, seed) {
  const n = members.length;
  const base = { key, n, seed, conc: 0, arms: 0, pitch: 0, ecc: 0, bulge: 0, bar: 0 };
  if (n <= GLOBULAR_MAX) return { ...base, kind: KIND.GLOBULAR, bulge: 1 };
  if (intake) return { ...base, kind: KIND.IRREGULAR, clumps: 2 + Math.round(rnd(seed, 601) * 2) };
  const conc = concentration(members);
  const meanDeg = members.reduce((s, m) => s + (m.degree ?? 0), 0) / n;
  // A disc whose members barely link to each other never formed a density
  // wave: that is a lenticular — a real disc with a bulge and no arms.
  if (meanDeg < 1.2) return { ...base, kind: KIND.LENTICULAR, conc, bulge: 0.3 + conc * 0.3 };
  return { ...base, kind: null, conc, meanDeg };
}

/** Classify every cluster together, placing the disc types by their RANK in
 *  this vault's concentration order rather than against fixed thresholds.
 *
 *  Absolute cut-offs do not survive contact with a real vault: this one's Gini
 *  values sit between 0.22 and 0.58, so any threshold set for "realistic"
 *  proportions (2-armed ~60-70% of spirals) collapsed 11 of 16 clusters onto
 *  the same shape — which is the complaint this whole file exists to fix. A
 *  rank keeps the ORDER honest (concentrated → few arms, tightly wound) while
 *  guaranteeing the map actually shows the sequence. It is the same call the
 *  project already makes for `heat`, which is a rank inside the vault too.
 *
 *  @returns Map key → morph */
export function classifyAll(entries, isIntake) {
  const out = new Map();
  const discs = [];
  entries.forEach(([key, members], i) => {
    const m = classifyGalaxy(key, members, isIntake(key, members), i + 1);
    out.set(key, m);
    if (m.kind === null) discs.push(m);
  });

  // Densest-and-most-concentrated clusters are ellipticals: no disc survived
  // there. Requiring BOTH keeps a small, tightly-linked folder from being
  // promoted just for having one hub.
  const byDens = [...discs].sort((a, b) => b.meanDeg - a.meanDeg);
  const denseCut = byDens[Math.floor(byDens.length * 0.12)]?.meanDeg ?? Infinity;

  const sorted = [...discs].sort((a, b) => b.conc - a.conc);
  sorted.forEach((m, rank) => {
    const pct = sorted.length > 1 ? rank / (sorted.length - 1) : 0;
    if (rank === 0 || (m.meanDeg >= denseCut && pct <= 0.15)) {
      Object.assign(m, { kind: KIND.ELLIPTICAL, bulge: 1, arms: 0, pitch: 0, ecc: 0, bar: 0 });
      return;
    }
    const step = SEQUENCE[Math.min(Math.floor(pct * SEQUENCE.length), SEQUENCE.length - 1)];
    Object.assign(m, { bar: 0, ...step });
  });
  return out;
}

/** Smooth 0→1 ramp — used to fade the arm perturbation in outside the bulge.
 *  Inside the inner Lindblad resonance there is no density wave, so the inner
 *  disc has to be smooth; a hard cut would draw a visible ring. */
const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Two uniform draws summed into a rough gaussian in [-1, 1]. */
const gauss = (i, s1, s2) => rnd(i, s1) + rnd(i, s2) - 1;

/** Sample the orbit radius of an exponential disc.
 *
 *  For a surface density Sigma ~ exp(-a/h) integrated over 2*pi*a da, the
 *  radial distribution is Gamma(2, h) — which is exactly the sum of two
 *  exponentials. Two logs, no rejection loop, and the result is the real
 *  Freeman profile instead of the old uniform-in-radius spread (which gave
 *  Sigma ~ 1/r, no bulge, and a hole in the middle). */
function sampleDiscRadius(h, u1, u2) {
  const a = Math.min(Math.max(u1, 0.004), 0.999);
  const b = Math.min(Math.max(u2, 0.004), 0.999);
  return -h * (Math.log(a) + Math.log(b));
}

/** Spheroidal draw with a steep central concentration — bulge and elliptical
 *  bodies. `flatten` squashes the z axis (E0 round … E7 lens). */
function spheroid(i, radius, flatten, salt) {
  const u = rnd(i, salt);
  const rr = radius * u * u; // steep, de Vaucouleurs-ish
  const th = rnd(i, salt + 2) * Math.PI * 2;
  const ph = Math.acos(2 * rnd(i, salt + 4) - 1);
  const sp = Math.sin(ph);
  return { x: sp * Math.cos(th) * rr, y: sp * Math.sin(th) * rr, z: Math.cos(ph) * rr * flatten };
}

/** Star position inside a classified galaxy — the morph-mode replacement for
 *  spiralLocal(). Same contract: local disc coordinates {x, y, z}, later put
 *  into world space by the caller's basis.
 *
 *  @param region  optional {arm, from, to} — confines the star to one arm and
 *                 one stretch of it. Sub-areas use this: a sub-folder becomes a
 *                 star-forming region ON an arm, not a galaxy of its own. */
export function morphLocal(morph, discR, i, t, spin, region = null) {
  switch (morph.kind) {
    case KIND.GLOBULAR:
      return spheroid(i, discR * 1.15, 0.82, 441);
    case KIND.ELLIPTICAL:
      return spheroid(i, discR * 0.98, 0.42 + rnd(morph.seed, 447) * 0.42, 451);
    case KIND.IRREGULAR:
      return irregular(morph, discR, i, t);
    default:
      return discStar(morph, discR, i, t, spin, region);
  }
}

/** Irregular / satellite: a few gravitationally shredded clumps, no symmetry.
 *  Deliberately NOT a disc — a Magellanic Cloud has no arms to speak of. */
function irregular(morph, discR, i, _t) {
  const clumps = morph.clumps ?? 3;
  const c = i % clumps;
  const cx = (rnd(c + morph.seed, 457) - 0.5) * discR * 1.5;
  const cy = (rnd(c + morph.seed, 461) - 0.5) * discR * 1.5;
  const cz = (rnd(c + morph.seed, 463) - 0.5) * discR * 0.5;
  const spread = discR * (0.3 + rnd(c + morph.seed, 467) * 0.35);
  return {
    x: cx + gauss(i, 469, 473) * spread,
    y: cy + gauss(i, 479, 487) * spread,
    z: cz + gauss(i, 491, 499) * spread * 0.4,
  };
}

/** The disc populations: bulge + arms + inter-arm, on density-wave orbits. */
function discStar(morph, discR, i, t, spin, region) {
  const { arms, pitch, ecc, bulge, bar } = morph;

  // #283 stays law: the winding has to move the angle OPPOSITE to the spin, or
  // the arms lead the rotation and the galaxy reads as turning backwards.
  const windingSign = spin < 0 ? 1 : -1;

  // ── bulge population: spheroidal, no arms, concentrated
  if (bulge > 0 && rnd(i, 503) < bulge && !region) {
    return spheroid(i, discR * 0.34, 0.72, 509);
  }

  const h = discR * 0.27; // exponential scale length
  // Arms only exist outside the bar / inner resonance; that radius is also
  // where the winding clock starts, so a barred galaxy's arms spring from the
  // ENDS of its bar the way real SB galaxies do.
  const aMin = discR * (bar > 0 ? bar : 0.17);

  // ── How many stars go INTO an arm.
  //
  // This is where the first version was wrong, and wrong for an interesting
  // reason. Real spiral arms are only a ~2x density enhancement over a smooth
  // disc — obvious in a galaxy of 10^11 stars, invisible in a cluster of 250
  // dots, because at that count a 2x enhancement is inside the shot noise. The
  // physically exact density wave produced a measured 2.0x contrast and looked
  // like a random scatter of points.
  //
  // So the arms are deliberately OVER-drawn: most stars sit in an arm, the rest
  // fill the space between. It stays a two-population disc with a real
  // inter-arm field — just weighted for a map with hundreds of points instead
  // of hundreds of billions.
  const ARM_SHARE = 0.82;

  let a;
  let phi;
  let armIndex = null;

  if (region) {
    // Sub-area: a contiguous stretch of ONE arm. Its members sit together as a
    // star-forming region instead of spawning a second spiral galaxy.
    armIndex = region.arm;
    const s = region.from + (region.to - region.from) * Math.min(Math.max(t, 0), 1);
    a = aMin + (discR - aMin) * Math.pow(s, 0.85);
    phi = 0; // resolved from the arm below
  } else {
    a = sampleDiscRadius(h, t, rnd(i, 521));
    // Gamma(2,h) has a long tail — with h = 0.27*discR it throws stars out past
    // twice the nominal radius, which breaks both the visual size and the
    // separation the web layout computed from discR. Real discs have no hard
    // edge either, so the tail is COMPRESSED rather than clipped: beyond the
    // rim the excess is logarithmically damped, which keeps a few outliers
    // without letting the disc double in size.
    const rim = discR * 0.92;
    if (a > rim) a = rim + Math.log1p((a - rim) / rim) * rim * 0.5;
    a = Math.max(a, discR * 0.02);
    // Uniform orbit phase — the arms come from orbit crowding, not from
    // assigning stars to arms. This is what fills the inter-arm disc.
    phi = rnd(i, 523) * Math.PI * 2;
  }

  // Logarithmic spiral: constant pitch angle, apsides precessing with ln a.
  const twist = windingSign * (Math.log(Math.max(a, aMin) / aMin) / Math.tan(pitch || 20 * DEG));

  let r;
  let ang;

  if (region) {
    // Ride the arm ridge, then offset PERPENDICULAR to it. The old code
    // scattered in the ANGLE by a constant, which made arms razor-thin in the
    // centre and fan out at the rim; a perpendicular offset keeps the arm the
    // same width all the way, like a real one.
    const armPhase = (armIndex / Math.max(arms, 1)) * Math.PI * 2;
    const ridge = twist + armPhase;
    const width = discR * 0.075;
    const off = gauss(i, 541, 547) * width;
    r = a + off * Math.cos(pitch);
    ang = ridge + (off * Math.sin(pitch)) / Math.max(a, 1);
  } else if (arms > 0) {
    // How strongly this radius belongs to the arm system: zero inside the bar /
    // inner resonance (no density wave there), full a bit further out. Without
    // the ramp the arms would start at a hard edge and draw a visible ring.
    const inArms = smoothstep(aMin * 0.9, aMin * 1.8, a);
    if (rnd(i, 577) < ARM_SHARE * inArms) {
      // Arm star: ride the ridge of one arm, scattered PERPENDICULAR to it.
      // The perpendicular offset (decomposed into radial and tangential parts
      // through the pitch angle) is what keeps an arm the same width from hub
      // to rim — scattering in the angle, as the shipped mode does, makes arms
      // razor-thin in the centre and fans them out at the edge.
      const k = Math.floor(rnd(i, 579) * arms) % arms;
      const ridge = twist + (k / arms) * Math.PI * 2;
      const off = gauss(i, 587, 593) * discR * 0.055;
      r = a + off * Math.cos(pitch);
      ang = ridge + (off * Math.sin(pitch)) / Math.max(a, 1);
    } else {
      // Inter-arm star: a real smooth disc underneath, with the m-mode
      // perturbation still nudging it — the arms are an enhancement OF this
      // population, not a separate thing floating above an empty disc.
      const strength = ecc * inArms;
      r = a * (1 + strength * Math.cos(arms * (phi - twist)));
      ang = phi;
    }
  } else {
    // Lenticular: a real disc, a real bulge, no density wave at all.
    r = a;
    ang = phi;
  }

  // Bar: inside its radius the orbits are stretched along one axis. Real SB
  // galaxies are ~2/3 of all spirals — including ours — so this is the common
  // case, not an exotic one.
  if (bar > 0 && a < aMin && !region) {
    const k = 1 - a / aMin;
    const bx = Math.cos(ang) * r * (1 + k * 0.85);
    const by = Math.sin(ang) * r * (1 - k * 0.6);
    return { x: bx, y: by, z: gauss(i, 557, 563) * discR * 0.045 };
  }

  // Thin disc that flares outward — h/R about 1/28 in the centre, ~1/10 at the
  // rim. The old code used a constant slab, which reads as a CD.
  const hz = discR * 0.032 * (1 + (a / discR) * 1.9);
  return { x: Math.cos(ang) * r, y: Math.sin(ang) * r, z: gauss(i, 569, 571) * hz };
}

/** The user's memories as an ACCRETION DISC around the core, not inside it.
 *
 *  Both galactic modes used to put the user cluster AT the origin, with the
 *  black hole drawn on top of it — so the memories closest to the user sat
 *  inside the event horizon. Anything inside a horizon is gone; drawing it
 *  there says the opposite of what the picture means.
 *
 *  An accretion disc is the physically right answer and the readable one: it
 *  has a hard inner edge (nothing orbits below the innermost stable orbit), it
 *  is thin, and it is brightest where it is fastest — right at the rim of the
 *  thing it feeds. The user's memories circle their own centre instead of
 *  vanishing into it.
 *
 *  @param innerR  the core radius — the disc starts clear of it
 *  @returns {x, y, z} in the disc's local frame */
export function accretionLocal(i, t, innerR, outerR) {
  // ONE circle. Not a disc, not a band, not a spiral.
  //
  // Two earlier versions got this wrong in two different ways: first the radius
  // grew monotonically with the index while the angle advanced by the golden
  // angle (a phyllotaxis spiral — it read as one arm sweeping outwards), then
  // the radius was drawn randomly across the whole band 123…419, which spreads
  // the points over an AREA. Both look scattered around the centre rather than
  // circling it.
  //
  // The radius is now the same for every member, so the memories sit on a true
  // ring, evenly spaced by index — with ~30 of them, random angles would leave
  // gaps. The tiny wobble keeps it from looking like a drawn circle without
  // breaking the shape.
  const ring = (innerR + outerR) / 2;
  const ang = t * Math.PI * 2;
  const rr = ring * (1 + (rnd(i, 907) - 0.5) * 0.05);
  return {
    x: Math.cos(ang) * rr,
    y: Math.sin(ang) * rr,
    // essentially flat — a ring, seen edge-on when the plane tilts
    z: (rnd(i, 913) + rnd(i, 919) - 1) * ring * 0.02,
    omegaScale: ACCRETION_SPEEDUP,
  };
}

/** Orbit parameters for the user's memories when the GRAVITY WEB core is on.
 *
 *  The web is the one core that reads the ring rather than just sitting next to
 *  it: its threads run from the centre to each memory. On the plain ring — one
 *  radius, one shared speed — every thread is the same length and stays that
 *  way, so the web renders as a rigid star and the motion is invisible.
 *
 *  The lab's version worked because each orbiting node had its OWN ellipse:
 *  `r: rand(26,52)`, `sp: speed*rand(0.72,1.3)`, `tilt: 0.35±0.12`,
 *  `flat: 0.42±0.06`. Two things follow, and both are the effect worth having:
 *    · different radii  → threads differ in length from each other
 *    · flattened orbits → each node's distance to the centre swings between
 *                         r*flat and r as it comes round, so the lengths keep
 *                         changing while it turns
 *
 *  Same parameters here, scaled to the ring's radius band. Returned as a live
 *  orbit rather than a fixed point, because the position now depends on time —
 *  worldPos evaluates it per frame.
 *
 *  @returns {orbit3d: {r, a0, sp, flat, tilt}} */
export function gravityWebLocal(i, innerR, outerR) {
  const spread = (salt, amp) => (rnd(i, salt) - 0.5) * 2 * amp;
  return {
    x: 0,
    y: 0,
    z: 0, // filled in per frame from orbit3d
    orbit3d: {
      r: innerR + rnd(i, 961) * (outerR - innerR),
      a0: rnd(i, 967) * Math.PI * 2,
      sp: 0.72 + rnd(i, 971) * 0.58, // lab: rand(0.72, 1.3)
      flat: 0.42 + spread(977, 0.06),
      tilt: 0.35 + spread(983, 0.12),
    },
    omegaScale: ACCRETION_SPEEDUP,
  };
}

/** How much faster the user's ring turns than the galaxy around it.
 *
 *  This ring orbits the BLACK HOLE, not the galaxy. Those are two different
 *  gravitational problems: out in the disc the mass is spread over the whole
 *  galaxy and a lap takes hundreds of seconds, while a ring sitting right on
 *  the hole is dominated by that one mass and races around it. Feeding the ring
 *  through the galactic rotation curve — which is what the first version did —
 *  gave it a 357 s lap: technically 2.3x quicker than the arms, and visually
 *  indistinguishable from standing still.
 *
 *  5x puts a lap at roughly 72 s — clearly turning without hurrying, and slow
 *  enough that a memory stays easy to catch under the cursor. (10x read as
 *  visibly too fast.) */
export const ACCRETION_SPEEDUP = 5;

/** Radius a classified galaxy should be drawn at. Capped in units of the
 *  universe radius by the caller — the shipped modes let bastra-recall grow to
 *  a disc wider than half the visible volume. */
export function morphRadius(kind, count) {
  if (kind === KIND.GLOBULAR) return Math.max(26, Math.sqrt(count) * 15);
  if (kind === KIND.ELLIPTICAL) return Math.max(55, Math.sqrt(count) * 24);
  // Same scale as the shipped mode (sqrt * 30). The first pass shrank this to
  // 26 and then capped it at R * 0.2, which made every spiral too small on
  // screen to read its arms at all.
  return Math.max(60, Math.sqrt(count) * 30);
}
