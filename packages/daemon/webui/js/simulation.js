/** Lightweight force layout — no d3 dependency. Cluster anchors sit on a
 *  relaxed phyllotaxis spiral; nodes are pulled to their anchor, pushed apart
 *  via a spatial hash grid, gently sprung along intra-cloud edges, and
 *  hard-separated by a radius-aware collision pass so no node ever covers
 *  another. The simulation cools down (alpha decay) and stops. */

import { nodeRadius } from "./graph-data.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Collision radius: drawn radius + bridge halo + breathing room, so the
 *  no-overlap guarantee covers the halo rings too. */
export const collisionRadius = (n) => nodeRadius(n) + (n.bridge ? 6.5 : 0) + 3.5;

export function createSimulation(graph, width, height, savedAnchors = null) {
  const cx = width / 2;
  const cy = height / 2;

  // Cluster centers: seeded on a spiral, then relaxed so no two cloud discs
  // overlap — heavily cross-linked vaults must still render as SEPARATE
  // clouds. `tx/ty` is the static anchor nodes are pulled towards; `x/y`
  // follows the live centroid of the members (labels + context menu use it).
  const totalCount = graph.clusters.reduce((s, c) => s + c.count, 0) || 1;
  const spread = Math.min(width, height) * 0.58 * Math.sqrt(Math.max(totalCount, 60) / 220);
  const centers = new Map();
  const cloudRadius = (count) => 34 * Math.sqrt(count) + 60;
  graph.clusters.forEach((c, i) => {
    const r = spread * Math.sqrt((i + 0.6) / Math.max(graph.clusters.length, 1));
    const a = i * GOLDEN;
    const saved = savedAnchors?.[c.key];
    centers.set(c.key, {
      key: c.key,
      tx: saved ? saved.x : cx + Math.cos(a) * r * 1.6,
      ty: saved ? saved.y : cy + Math.sin(a) * r * 1.05,
      // a user-placed cloud keeps its spot during setup relaxation; the live
      // separation (separateClouds) may still nudge it later, animated.
      pinned: Boolean(saved),
      x: 0,
      y: 0,
      count: c.count,
    });
  });
  const minAnchorDist = (a, b) => (cloudRadius(a.count) + cloudRadius(b.count)) * 0.95 + 60;
  // relax anchor positions: push overlapping cloud discs apart. User-pinned
  // anchors stay put here — only free (new/unsaved) clouds make room.
  const centerList = [...centers.values()];
  for (let iter = 0; iter < 120; iter++) {
    let moved = false;
    for (let i = 0; i < centerList.length; i++) {
      for (let j = i + 1; j < centerList.length; j++) {
        const a = centerList[i];
        const b = centerList[j];
        if (a.pinned && b.pinned) continue;
        const minD = minAnchorDist(a, b);
        let dx = b.tx - a.tx;
        let dy = b.ty - a.ty;
        let d = Math.hypot(dx, dy);
        if (d === 0) {
          dx = 1;
          dy = 0.5;
          d = 1;
        }
        if (d < minD) {
          const push = minD - d;
          let wa = cloudRadius(b.count) / (cloudRadius(a.count) + cloudRadius(b.count));
          if (a.pinned) wa = 0;
          if (b.pinned) wa = 1;
          a.tx -= (dx / d) * push * wa;
          a.ty -= (dy / d) * push * wa;
          b.tx += (dx / d) * push * (1 - wa);
          b.ty += (dy / d) * push * (1 - wa);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  for (const c of centerList) {
    c.x = c.tx;
    c.y = c.ty;
  }

  // Node particles, seeded in a disc around their cluster anchor. `cr` is the
  // collision radius (collisionRadius above).
  const nodes = graph.nodes.map((n, i) => {
    const c = centers.get(n.cluster) ?? { x: cx, y: cy, count: 1 };
    const a = i * GOLDEN * 7.3;
    const rr = Math.sqrt(Math.random()) * (16 + Math.sqrt(c.count) * 16);
    return {
      ...n,
      x: c.x + Math.cos(a) * rr,
      y: c.y + Math.sin(a) * rr,
      vx: 0,
      vy: 0,
      cr: collisionRadius(n),
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges
    .map((e) => ({ ...e, s: byId.get(e.source), t: byId.get(e.target) }))
    .filter((e) => e.s && e.t);

  let alpha = 1;
  let settled = false;

  /** Radius-aware hard separation — the no-overlap guarantee. */
  function collide(iterations) {
    const CELL = 56; // ≥ 2 × max collision radius
    for (let it = 0; it < iterations; it++) {
      const grid = new Map();
      for (const n of nodes) {
        const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = []));
        cell.push(n);
      }
      let any = false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const gx = Math.floor(n.x / CELL);
        const gy = Math.floor(n.y / CELL);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const cell = grid.get(`${gx + dx},${gy + dy}`);
            if (!cell) continue;
            for (const m of cell) {
              if (m.idx <= i) continue; // each pair once
              let ddx = m.x - n.x;
              let ddy = m.y - n.y;
              let d = Math.hypot(ddx, ddy);
              const minD = n.cr + m.cr;
              if (d >= minD) continue;
              if (d === 0) {
                ddx = Math.random() - 0.5;
                ddy = Math.random() - 0.5;
                d = Math.hypot(ddx, ddy);
              }
              const push = (minD - d) / 2;
              n.x -= (ddx / d) * push;
              n.y -= (ddy / d) * push;
              m.x += (ddx / d) * push;
              m.y += (ddy / d) * push;
              any = true;
            }
          }
        }
      }
      if (!any) break;
    }
  }
  nodes.forEach((n, i) => (n.idx = i));

  function updateCentroids() {
    for (const c of centers.values()) {
      c.sx = 0;
      c.sy = 0;
      c.n = 0;
    }
    for (const n of nodes) {
      const c = centers.get(n.cluster);
      if (c) {
        c.sx += n.x;
        c.sy += n.y;
        c.n += 1;
      }
    }
    for (const c of centers.values()) {
      if (c.n > 0) {
        c.x = c.sx / c.n;
        c.y = c.sy / c.n;
      }
    }
  }

  function tick() {
    if (alpha < 0.005) {
      if (!settled) {
        collide(30); // final settle: resolve every last overlap
        updateCentroids();
        settled = true;
        return true;
      }
      return false;
    }

    // pull to the cluster ANCHOR — the force that shapes the clouds
    for (const n of nodes) {
      const c = centers.get(n.cluster);
      if (c) {
        n.vx += (c.tx - n.x) * 0.012 * alpha;
        n.vy += (c.ty - n.y) * 0.012 * alpha;
      }
    }

    // pairwise repulsion via spatial hash (cell = interaction radius)
    const CELL = 56;
    const grid = new Map();
    for (const n of nodes) {
      const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push(n);
    }
    for (const n of nodes) {
      const gx = Math.floor(n.x / CELL);
      const gy = Math.floor(n.y / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get(`${gx + dx},${gy + dy}`);
          if (!cell) continue;
          for (const m of cell) {
            if (m === n) continue;
            let ddx = n.x - m.x;
            let ddy = n.y - m.y;
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 === 0) {
              ddx = Math.random() - 0.5;
              ddy = Math.random() - 0.5;
              d2 = 0.01;
            }
            if (d2 < CELL * CELL) {
              const f = (160 * alpha) / d2;
              n.vx += ddx * f;
              n.vy += ddy * f;
            }
          }
        }
      }
    }

    // weak link springs — INTRA-cluster only. Cross-cluster edges are viewing
    // relations (hover highlights), never layout forces: with a heavily
    // cross-linked vault they would drag all clouds into one central clump.
    for (const e of edges) {
      if (e.s.cluster !== e.t.cluster) continue;
      const dx = e.t.x - e.s.x;
      const dy = e.t.y - e.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 72) / d) * 0.004 * alpha;
      e.s.vx += dx * f;
      e.s.vy += dy * f;
      e.t.vx -= dx * f;
      e.t.vy -= dy * f;
    }

    for (const n of nodes) {
      n.x += n.vx *= 0.82;
      n.y += n.vy *= 0.82;
    }

    collide(2); // keep the no-overlap guarantee while the layout moves

    // labels + context menu follow the live centroid of each cloud
    updateCentroids();

    alpha *= 0.985;
    return true;
  }

  /** Kept for viewers that want to re-heat after user interaction. */
  function reheat(a = 0.3) {
    alpha = Math.max(alpha, a);
    settled = false;
  }

  // ── manual cloud dragging ─────────────────────────────────────────
  const membersOf = new Map();
  for (const n of nodes) {
    let list = membersOf.get(n.cluster);
    if (!list) membersOf.set(n.cluster, (list = []));
    list.push(n);
  }

  /** Move a whole cloud (anchor + every member node) by a world delta. */
  function shiftCluster(key, dx, dy) {
    const c = centers.get(key);
    if (!c) return;
    c.tx += dx;
    c.ty += dy;
    c.x += dx;
    c.y += dy;
    for (const n of membersOf.get(key) ?? []) {
      n.x += dx;
      n.y += dy;
    }
  }

  /**
   * Live safety-distance keeper, called once per frame. When a dragged cloud
   * crowds another, the other one glides away (exponential easing — a fixed
   * fraction of the remaining overlap per frame, so evasion looks animated
   * and chain reactions resolve over the following frames). Returns true
   * while anything is still moving so callers can persist positions after
   * the dust settles.
   */
  function separateClouds(draggedKey = null) {
    let movedAny = false;
    const EASE = 0.16;
    const BACK_EASE = 0.045; // gravity-back: far softer than the evasion
    const BACK_MAX = 4.5; // px/frame cap — distant clouds drift, never race
    const BAND = 1.35; // comfort orbit: min distance + 35% buffer
    for (let i = 0; i < centerList.length; i++) {
      for (let j = i + 1; j < centerList.length; j++) {
        const a = centerList[i];
        const b = centerList[j];
        const minD = minAnchorDist(a, b);
        let dx = b.tx - a.tx;
        let dy = b.ty - a.ty;
        let d = Math.hypot(dx, dy);
        if (d === 0) {
          dx = 1;
          dy = 0.5;
          d = 1;
        }
        if (d >= minD - 0.5) {
          // gravity back: the dragged cloud is the field's anchor — anything
          // it pushed away (or left behind) drifts gently back in until it
          // rests inside the comfort band. The dead zone between push and
          // pull keeps the orbit calm — no flutter between the two forces.
          if (draggedKey === null) continue;
          if (a.key !== draggedKey && b.key !== draggedKey) continue;
          const band = minD * BAND;
          if (d <= band) continue;
          const pull = Math.min((d - band) * BACK_EASE, BACK_MAX);
          if (a.key === draggedKey) shiftCluster(b.key, -(dx / d) * pull, -(dy / d) * pull);
          else shiftCluster(a.key, (dx / d) * pull, (dy / d) * pull);
          movedAny = true;
          continue;
        }
        const push = (minD - d) * EASE;
        let wa = 0.5; // nobody dragged: both give way
        if (a.key === draggedKey) wa = 0; // the grabbed cloud never yields
        if (b.key === draggedKey) wa = 1;
        if (wa > 0) shiftCluster(a.key, -(dx / d) * push * wa, -(dy / d) * push * wa);
        if (wa < 1) shiftCluster(b.key, (dx / d) * push * (1 - wa), (dy / d) * push * (1 - wa));
        movedAny = true;
      }
    }
    return movedAny;
  }

  /** Current anchor positions, for persistence. */
  function anchorPositions() {
    const out = {};
    for (const [key, c] of centers) out[key] = { x: Math.round(c.tx), y: Math.round(c.ty) };
    return out;
  }

  /** Grouping-mode switch: nodes carry NEW n.cluster values — rebuild the
   *  anchor/member structures from the members' current centroids and reheat.
   *  The per-frame separateClouds pass then pushes the new clouds apart,
   *  animated; no hard re-layout. */
  function regroup(savedAnchors = null) {
    const counts = new Map();
    const sums = new Map();
    for (const n of nodes) {
      counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);
      const s = sums.get(n.cluster) ?? { x: 0, y: 0 };
      s.x += n.x;
      s.y += n.y;
      sums.set(n.cluster, s);
    }
    centers.clear();
    centerList.length = 0;
    for (const [key, count] of counts) {
      const s = sums.get(key);
      const saved = savedAnchors?.[key];
      const c = {
        key,
        tx: saved ? saved.x : s.x / count,
        ty: saved ? saved.y : s.y / count,
        pinned: Boolean(saved),
        x: s.x / count,
        y: s.y / count,
        count,
      };
      centers.set(key, c);
      centerList.push(c);
    }
    membersOf.clear();
    for (const n of nodes) {
      let list = membersOf.get(n.cluster);
      if (!list) membersOf.set(n.cluster, (list = []));
      list.push(n);
    }
    reheat(1);
  }

  return { nodes, edges, centers, byId, tick, reheat, shiftCluster, separateClouds, anchorPositions, regroup };
}
