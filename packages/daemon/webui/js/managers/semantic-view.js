/** Semantic view: nodes positioned by MEANING (server-side PCA over the
 *  embedding vectors) instead of by folder. The point of the view are the
 *  unwritten connections — pairs the embeddings consider close but no note
 *  ever linked — drawn as their own dashed strands. Cluster colors stay,
 *  so folder-vs-meaning disagreements show at a glance.
 *
 *  The server layout is cached for the session; entering again is instant.
 *
 *  @param {object} deps
 *  @param {object} deps.sim       simulation (nodes, edges, byId)
 *  @param {object} deps.renderer  canvas renderer */

import { fetchSemanticLayout, nodeRadius } from "../graph-data.js";

const $ = (sel) => document.querySelector(sel);
const GOLDEN = 2.399963; // radians — deterministic scatter for fallbacks
const MODE_KEY = "bastra-vault-map-semantic-mode";
const SPIN_KEY = "bastra-vault-map-semantic-spin";
const SPIN = 0.045; // rad/s auto-drift — OPT-IN (spin button in the hint)
const PITCH_MAX = 1.1;

export function createSemanticView(deps) {
  let layout = null; // server response, fetched once per session
  let targets = null; // id → {x, y} world positions, relaxed (2D mode)
  let points3d = null; // id → {px, py, pz} world-scale meaning coordinates
  let semEdges = []; // unwritten connections with node refs
  let mode = localStorage.getItem(MODE_KEY) === "3d" ? "3d" : "2d";
  let active = false; // view currently entered (tick guard)
  // Navigation wie im Orbit (Daniels Regel: nie Dauerrotation ohne
  // Steuerung): Drag rotiert, Shift-Drag pannt, Auto-Spin ist eine OPTION
  // und default aus.
  let yaw = 0.6;
  let pitch = -0.32;
  let autoSpin = localStorage.getItem(SPIN_KEY) === "on";
  let lastNow = 0;

  /** World targets from the unit-square layout: scale to a box that grows
   *  with the vault, place vectorless notes/ghosts near their linked
   *  neighbors, then relax until nothing overlaps (the no-overlap rule). */
  function computeTargets() {
    const placed = new Map();
    const side = Math.max(760, Math.sqrt(layout.positions.length) * 64);
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    for (const p of layout.positions) {
      placed.set(p.id, { x: cx + (p.x - 0.5) * side, y: cy + (p.y - 0.5) * side });
    }

    // fallbacks (ghosts, embedding gaps): average of already-placed link
    // neighbors; two passes so chains resolve; center scatter as last resort
    for (let pass = 0; pass < 2; pass++) {
      for (const n of deps.sim.nodes) {
        if (placed.has(n.id)) continue;
        let sx = 0;
        let sy = 0;
        let count = 0;
        for (const e of deps.sim.edges) {
          const other = e.s.id === n.id ? e.t : e.t.id === n.id ? e.s : null;
          const p = other && placed.get(other.id);
          if (p) {
            sx += p.x;
            sy += p.y;
            count++;
          }
        }
        if (count > 0) {
          const a = n.idx * GOLDEN;
          placed.set(n.id, {
            x: sx / count + Math.cos(a) * 30,
            y: sy / count + Math.sin(a) * 30,
          });
        }
      }
    }
    for (const n of deps.sim.nodes) {
      if (placed.has(n.id)) continue;
      const a = n.idx * GOLDEN;
      const r = 40 + 14 * Math.sqrt(n.idx);
      placed.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }

    relax(placed);
    return placed;
  }

  /** 3D meaning coordinates (zzallirog: "a wire between two things you've
   *  already made") — the unit-cube layout scaled to the same world box the
   *  2D mode uses; fallback nodes (ghosts, embedding gaps) sit on the z=0
   *  plane at their relaxed 2D spot, so they stay near their neighbors. */
  function computePoints3d() {
    const side = Math.max(760, Math.sqrt(layout.positions.length) * 64);
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const byId = new Map(layout.positions.map((p) => [p.id, p]));
    const pts = new Map();
    for (const n of deps.sim.nodes) {
      const p = byId.get(n.id);
      if (p) {
        pts.set(n.id, {
          px: (p.x - 0.5) * side,
          py: (p.y - 0.5) * side,
          pz: (p.z - 0.5) * side,
        });
      } else {
        const t = targets.get(n.id);
        pts.set(n.id, { px: (t?.x ?? cx) - cx, py: (t?.y ?? cy) - cy, pz: 0 });
      }
    }
    return pts;
  }

  /** Orbit-style perspective projection of the meaning cloud at the CURRENT
   *  camera angles (drag-controlled; auto-spin only nudges yaw when on). */
  function projectAll(intoMap = null) {
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const side = Math.max(760, Math.sqrt(layout.positions.length) * 64);
    for (const n of deps.sim.nodes) {
      const p = points3d.get(n.id);
      if (!p) continue;
      const x1 = p.px * cosY + p.pz * sinY;
      const z1 = -p.px * sinY + p.pz * cosY;
      const y2 = p.py * cosP - z1 * sinP;
      const z2 = p.py * sinP + z1 * cosP;
      const d = z2 / (side * 0.9);
      const persp = 1 / (1 + Math.max(d, -1.2) * 0.42);
      const x = cx + x1 * persp;
      const y = cy + y2 * persp;
      if (intoMap) {
        intoMap.set(n.id, { x, y });
        continue;
      }
      n.x = x;
      n.y = y;
      // depth cues via the shared hooks (orbit pattern): size, alpha, order
      n.orbitDepth = d;
      n.ringScale = Math.min(Math.max(persp, 0.55), 1.35);
      n.ringFade = Math.min(Math.max(1 - (d + 1) * 0.35, 0.45), 1);
    }
  }

  const byDepth = (a, b) => (b.orbitDepth ?? 0) - (a.orbitDepth ?? 0);

  function clearDepthCues() {
    deps.renderer.setDrawOrder(null);
    for (const n of deps.sim.nodes) {
      delete n.orbitDepth;
      delete n.ringScale;
      delete n.ringFade;
    }
  }

  /** Depth-Interaktion an/aus: Drag rotiert (Shift-Drag fällt aufs Pannen
   *  zurück — exakt das Orbit-Muster), Hint zeigt die Steuerung + Spin-Knopf. */
  function applyDepthState() {
    const depth = active && mode === "3d";
    deps.getInteractions?.().setDragDelegate(
      depth
        ? (dx, dy, ev) => {
            if (ev?.shiftKey) return false; // shift-drag = pan through space
            yaw += dx * 0.005;
            pitch = Math.min(Math.max(pitch + dy * 0.004, -PITCH_MAX), PITCH_MAX);
            projectAll();
          }
        : null
    );
    if (depth) deps.renderer.setDrawOrder(byDepth);
    else clearDepthCues();
    const controls = $("#semantic-depth-controls");
    if (controls) controls.hidden = !depth;
    renderSpinButton();
  }

  function renderSpinButton() {
    const b = $("#semantic-spin");
    if (b) b.textContent = `↻ spin: ${autoSpin ? "on" : "off"}`;
  }

  $("#semantic-spin")?.addEventListener("click", () => {
    autoSpin = !autoSpin;
    localStorage.setItem(SPIN_KEY, autoSpin ? "on" : "off");
    renderSpinButton();
  });

  /** Per-frame drive in 3D mode — projects at the current angles; auto-spin
   *  (opt-in) nudges the yaw, dragging works with spin on or off. */
  // hold(): an open memory card stops the spin; the release eases it back in
  let held = false;
  let ramp = 1; // 0 … 1 over 1.4 s; the speed is its smoothstep
  function tick(now) {
    const dt = lastNow > 0 ? Math.min((now - lastNow) / 1000, 0.1) : 0;
    lastNow = now;
    ramp = held ? 0 : Math.min(ramp + dt / 1.4, 1);
    if (!active || mode !== "3d") return;
    if (autoSpin) yaw += dt * SPIN * ramp * ramp * (3 - 2 * ramp);
    projectAll();
  }

  /** Target positions for a mode switch — the caller animates the flight. */
  function targetsForMode(m) {
    if (m === "3d") {
      const map = new Map();
      projectAll(map);
      return map;
    }
    return targets;
  }

  function setMode(m) {
    mode = m === "3d" ? "3d" : "2d";
    localStorage.setItem(MODE_KEY, mode);
    if (active) applyDepthState();
  }

  /** Radius-aware separation on the target map — PCA packs the middle
   *  densely; a few push-apart passes make every node hittable. */
  function relax(placed) {
    const items = deps.sim.nodes.map((n) => ({
      p: placed.get(n.id),
      r: nodeRadius(n) + 5,
    }));
    for (let it = 0; it < 24; it++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i];
          const b = items[j];
          const dx = b.p.x - a.p.x;
          const dy = b.p.y - a.p.y;
          const min = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 0.01;
          const push = (min - d) / 2 + 0.3;
          const ux = d < 0.02 ? Math.cos(i * GOLDEN) : dx / d;
          const uy = d < 0.02 ? Math.sin(i * GOLDEN) : dy / d;
          a.p.x -= ux * push;
          a.p.y -= uy * push;
          b.p.x += ux * push;
          b.p.y += uy * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /** Fetches (once), computes targets, arms the dashed strands. Returns the
   *  node target positions for the caller's view transition. Throws when the
   *  daemon has no embeddings yet — the caller keeps the current view. */
  async function enter() {
    if (!layout) layout = await fetchSemanticLayout();
    if (!targets) {
      targets = computeTargets();
      semEdges = layout.edges
        .map((e) => ({ s: deps.sim.byId.get(e.source), t: deps.sim.byId.get(e.target), sim: e.sim }))
        .filter((e) => e.s && e.t);
    }
    if (!points3d) points3d = computePoints3d();
    active = true;
    deps.renderer.setSemanticEdges(semEdges);
    deps.renderer.setClusterLabelsVisible(false); // clusters interleave here
    applyDepthState();
    $("#semantic-hint").hidden = false;
    return targetsForMode(mode);
  }

  function exit() {
    active = false;
    held = false;
    ramp = 1;
    applyDepthState(); // löst Drag-Delegate + Depth-Cues + Controls
    deps.renderer.setSemanticEdges(null);
    deps.renderer.setClusterLabelsVisible(true);
    $("#semantic-hint").hidden = true;
  }

  return {
    enter,
    exit,
    tick,
    /** Hold the auto-spin still (true) or let it ease back in (false). */
    hold: (on) => {
      held = !!on;
    },
    setMode,
    getMode: () => mode,
    targetsForMode,
    /** unwritten connections (node refs) — [] until the view was entered */
    getEdges: () => semEdges,
  };
}
