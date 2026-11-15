/** Ring view: the whole vault as one wheel, modeled on the classic
 *  system-wheel look — a small center emblem, wedge segments that GROW
 *  outward with cluster size (short stubs for small clusters, long blades
 *  for big ones), and ONE enclosing dashed orbit carrying the unwritten
 *  notes. Documents and bookmarks are ordinary knowledge clusters and sit
 *  in wedges like everything else.
 *
 *  Packing is radius-aware (uses each node's collision radius `cr`), so the
 *  no-overlap guarantee of the cloud view holds here too. Deterministic —
 *  no simulation. */

const TAU = Math.PI * 2;

export function computeRingLayout(nodes, width, height, opts = {}) {
  // opts.keyOf — segment key per node (default: displayed cluster).
  //   The ring browser drills in by passing n => n.baseCluster with only the
  //   drilled area's nodes.
  // opts.headline — drill mode: the area name shown at the top (back target).
  const keyOf = opts.keyOf ?? ((n) => n.cluster);
  const cx = width / 2;
  const cy = height / 2;
  const R_CENTER = 64; // emblem disc
  const R0 = R_CENTER + 38; // first wedge row

  // Meta level (#216): rules (taxonomy/conventions) and skills are the layer
  // that frames the content — they get their own outer band, not a wedge
  // between the content blocks. Detected by group, GROUPED by keyOf so the
  // segment names match the active legend keys in both structure modes.
  // Ghost check runs first: an unwritten note linked from a rules memory
  // stays on the unwritten orbit.
  const isMeta = opts.metaOf ?? ((n) => n.group === "rules" || n.group === "skills");
  const ghosts = [];
  const byCluster = new Map();
  const metaByKey = new Map();
  for (const n of nodes) {
    if (n.kind === "ghost") {
      ghosts.push(n);
    } else if (isMeta(n)) {
      const key = keyOf(n);
      const l = metaByKey.get(key) ?? [];
      l.push(n);
      metaByKey.set(key, l);
    } else {
      const key = keyOf(n);
      const l = byCluster.get(key) ?? [];
      l.push(n);
      byCluster.set(key, l);
    }
  }

  // biggest wedge first, clockwise — small clusters end up grouped as stubs
  const clusters = [...byCluster.entries()].sort((a, b) => b[1].length - a[1].length);
  const GAP = 0.03;
  const usable = TAU - GAP * clusters.length;
  const weights = clusters.map(([, l]) => Math.sqrt(l.length));
  const wSum = weights.reduce((s, w) => s + w, 0) || 1;
  const rawSpans = weights.map((w) => Math.max((w / wSum) * usable, 0.09));
  const spanScale = usable / rawSpans.reduce((s, x) => s + x, 0);

  const positions = new Map();
  const centers = new Map();
  const segments = []; // { key, a0, a1, outer, subDividers } — band text + dividers
  let angle = -Math.PI / 2;
  let maxOuter = R0;

  /** Radial size damping: nodes near the hub draw (and pack) smaller, so
   *  nothing overhangs the inner border — full size from ~150px out. */
  const ringScaleAt = (rowInner) => Math.min(0.5 + (rowInner - R0) / 150, 1);

  /** Pack one wedge (or sub-wedge): rows from the inside out, arc-budgeted
   *  by each node's DAMPED collision radius. Nothing may ever cross the
   *  wedge borders: a node wider than the arc is pushed outward until the
   *  arc is wide enough (and clamped as a last resort). Returns the outer
   *  edge. */
  function packWedge(members, a0, span, startR = R0) {
    members.sort((a, b) => (a.cr ?? 6) - (b.cr ?? 6)); // small inside
    let i = 0;
    let rowInner = startR;
    while (i < members.length) {
      // narrow wedge + big node → move the row outward where the arc is wider
      const firstEr = (members[i].cr ?? 6) * ringScaleAt(rowInner);
      const needR = (firstEr * 2 + 6) / span;
      if (needR > rowInner) rowInner = needR;

      const scale = ringScaleAt(rowInner);
      const budget = span * rowInner;
      const effOf = (n) => {
        let er = (n.cr ?? 6) * scale;
        er = Math.min(er, (budget - 5) / 2); // hard cap: never wider than the arc
        return Math.max(er, 1.2);
      };
      const row = [];
      let rowMax = 0;
      let used = 0;
      while (i < members.length) {
        const n = members[i];
        const er = effOf(n);
        const cost = er * 2 + 5;
        if (row.length > 0 && used + cost > budget) break;
        n.ringScale = er / (n.cr ?? 6);
        n.ringEr = er;
        row.push(n);
        used += cost;
        rowMax = Math.max(rowMax, er);
        i += 1;
      }
      const r = rowInner + rowMax;
      let a = a0 + Math.max((span - used / r) / 2, 0);
      for (const n of row) {
        const share = (n.ringEr * 2 + 5) / r;
        const na = a + share / 2;
        positions.set(n.id, { x: cx + Math.cos(na) * r, y: cy + Math.sin(na) * r });
        a += share;
      }
      rowInner = r + rowMax + 4;
    }
    return rowInner;
  }

  clusters.forEach(([key, members], ci) => {
    const span = rawSpans[ci] * spanScale;
    // ONE unbroken area per segment — subcategories only appear after
    // drilling in (the ring browser), never as inline dividers
    const outer = packWedge(members, angle, span);
    maxOuter = Math.max(maxOuter, outer);
    segments.push({ key, a0: angle, a1: angle + span, outer, b0: angle - GAP / 2, b1: angle + span + GAP / 2 });
    // center anchor = segment midpoint (context menu / cluster fits); the
    // visible name lives as curved text in the label band, not here
    const mid = angle + span / 2;
    const midR = (R0 + outer) / 2;
    centers.set(key, { x: cx + Math.cos(mid) * midR, y: cy + Math.sin(mid) * midR });
    angle += span + GAP;
  });

  // ── the label band: a visible ring carrying the curved segment names.
  // Names must ALWAYS be fully readable — the band radius grows until the
  // longest name fits its segment's arc (12px world-space font, ~9.5px per
  // tracked uppercase glyph; the wheel is infinitely zoomable, so growing
  // the ring costs nothing).
  let bandInner = maxOuter + 10;
  for (const seg of segments) {
    const needed = (seg.key.length * 9.5 + 14) / ((seg.a1 - seg.a0) * 0.92);
    bandInner = Math.max(bandInner, needed);
  }
  const band = { rInner: bandInner, rOuter: bandInner + 30 };

  // ── the meta band (#216): the framing layer — rules + skills — as its own
  // outer wheel level, built with the exact wedge→label-band mechanics of the
  // main wheel, just radially offset. null when the layout holds no meta
  // nodes (drill layouts), so the decor fades it out for free.
  let metaBand = null;
  if (metaByKey.size > 0) {
    const metaR0 = band.rOuter + 24;
    const metaEntries = [...metaByKey.entries()].sort((a, b) => b[1].length - a[1].length);
    const mUsable = TAU - GAP * metaEntries.length;
    const mWeights = metaEntries.map(([, l]) => Math.sqrt(l.length));
    const mSum = mWeights.reduce((s, w) => s + w, 0) || 1;
    const mRaw = mWeights.map((w) => Math.max((w / mSum) * mUsable, 0.09));
    const mScale = mUsable / mRaw.reduce((s, x) => s + x, 0);
    const metaSegments = [];
    // start offset keeps meta names away from the UNWRITTEN label at 12 o'clock
    let mAngle = -Math.PI / 2 + 0.35;
    let metaMaxOuter = metaR0;
    metaEntries.forEach(([key, members], mi) => {
      const span = mRaw[mi] * mScale;
      const outer = packWedge(members, mAngle, span, metaR0);
      metaMaxOuter = Math.max(metaMaxOuter, outer);
      metaSegments.push({
        key,
        a0: mAngle,
        a1: mAngle + span,
        outer,
        b0: mAngle - GAP / 2,
        b1: mAngle + span + GAP / 2,
      });
      const mid = mAngle + span / 2;
      const midR = (metaR0 + outer) / 2;
      centers.set(key, { x: cx + Math.cos(mid) * midR, y: cy + Math.sin(mid) * midR });
      mAngle += span + GAP;
    });
    let metaInner = metaMaxOuter + 10;
    for (const seg of metaSegments) {
      const needed = (seg.key.length * 9.5 + 14) / ((seg.a1 - seg.a0) * 0.92);
      metaInner = Math.max(metaInner, needed);
    }
    metaBand = { rInner: metaInner, rOuter: metaInner + 26, segments: metaSegments };
  }

  // ── the one enclosing orbit: unwritten notes (dashed, like their nodes) ──
  const orbits = [];
  if (ghosts.length) {
    const orbitR = (metaBand ? metaBand.rOuter : band.rOuter) + 40;
    ghosts.forEach((n, i) => {
      n.ringScale = 1;
      const a = -Math.PI / 2 + (TAU * i) / ghosts.length;
      positions.set(n.id, { x: cx + Math.cos(a) * orbitR, y: cy + Math.sin(a) * orbitR });
    });
    orbits.push({ key: "unwritten", label: "unwritten", r: orbitR, dashed: true });
  }

  const outerRadius = orbits.length ? orbits[orbits.length - 1].r : metaBand ? metaBand.rOuter : band.rOuter;

  return {
    positions,
    centers,
    segments,
    band,
    metaBand,
    outerRadius,
    // rInner: the extra inner ring staggering the gap between emblem and wedges
    center: { x: cx, y: cy, r: R_CENTER, r0: R0, rInnerRing: R_CENTER + 16 },
    orbits,
    headline: opts.headline ?? null,
  };
}
