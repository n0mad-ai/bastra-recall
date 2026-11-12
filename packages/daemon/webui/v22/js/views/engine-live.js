// Live vault events in the engine views — the map half of the old
// live-updates.js (#216/#217): "add" adopts the newborn as a real node and
// lights a supernova (Mindspace draws it at its 3D spot, Clouds/Semantic above
// a node of its area), "change"/"delete"/"read" flare the node in the kind's
// colour. The notice cards and the session history belong to the Live tab and
// are not drawn here. Events come from data.js (onUpdates); the engines and
// the shared live-kinds table are imported unchanged from the old UI.
import { clusterHues } from "../../../js/graph-data.js";
import { createLiveNodes } from "../../../js/live-nodes.js";
import { drawBurstAt, BURST_LIFE } from "../../../js/managers/orbit-view.js";
import { KIND_META } from "../../../js/managers/live-kinds.js";

const str = (v) => (typeof v === "string" ? v : "");

/**
 * Wire the live lane into a built engine. deps: { awake(ms), regroup() }.
 * Returns { apply(update), hasBursts(now) }.
 */
export function installLive(e, { awake, regroup }) {
  const nodes = createLiveNodes({
    sim: e.sim,
    inspector: null,
    select: () => {},
    getStructureMode: () => e.structure,
    onAdopt: (n) => grow(n),
  });

  /** #307: a newborn may open a new area — append it (hue = list index), so
   *  nothing else is repainted; only the view on screen re-derives its layout. */
  function grow(node) {
    const touch = (list, key, keyOf) => {
      if (!key) return false;
      let count = 0;
      for (const n of e.sim.nodes) if (keyOf(n) === key) count += 1;
      const hit = list.find((c) => c.key === key);
      if (hit) { hit.count = count; return false; }
      list.push({ key, count });
      return true;
    };
    const freshCluster = touch(e.graph.clusters, node.baseCluster, (n) => n.baseCluster ?? n.cluster);
    const freshGroup = touch(e.graph.groups, node.group, (n) => n.group);
    if (!freshCluster && !freshGroup && e.sim.centers.has(node.cluster)) return;
    e.hues = clusterHues(e.structure === "blocks" ? e.graph.groups : e.graph.clusters);
    e.renderer.setHues(e.hues);
    if (e.view === "clouds") regroup();
    e.orbit.invalidate();
  }

  // supernovae in every engine view, above the nodes (old live-updates overlay)
  e.renderer.setOverlay((ctx, camera, theme, now) => {
    if (e.view === "orbit") { e.orbit.renderBursts(ctx, camera, theme, now); return; }
    for (const b of e.orbit.listBursts()) {
      const age = (now - b.born) / 1000;
      if (age > BURST_LIFE) continue;
      const anchor = e.sim.nodes.find((n) => (n.baseCluster === b.cluster || n.cluster === b.cluster) && !n.ringHidden);
      if (anchor) drawBurstAt(ctx, camera, theme, anchor.x, anchor.y - 16, 1, age);
    }
  });

  function apply(raw) {
    // external data: only well-formed events of a known kind
    if (!raw || typeof raw.id !== "string" || !KIND_META[raw.kind]) return;
    const u = { ...raw, title: str(raw.title) || raw.id, type: str(raw.type), summary: str(raw.summary), count: Number.isFinite(raw.count) ? raw.count : 1 };
    if (u.kind === "add") {
      if (typeof u.cluster !== "string" || !u.cluster) return;
      nodes.adoptLiveNode(u); // a real node first (#217), then the star above it
      e.orbit.spawnBurst(u);
      awake(2600); // flash + shockwave at full rate, then the idle cadence
      return;
    }
    const n = e.sim.byId.get(u.id);
    if (!n) return;
    const flash = KIND_META[u.kind].flash;
    // the flare's lifetime carries how much happened (×N coalesced hits)
    if (flash) { e.renderer.flashNode(n.id, flash, 5000 + Math.min(u.count - 1, 4) * 2500); awake(e.renderer.getBoltMs() + 1500); }
    if (u.kind === "change") {
      n.title = u.title; n.summary = u.summary;
      if (typeof u.salience === "number") n.salience = u.salience; else delete n.salience;
      if (typeof u.emotion === "string" && u.emotion) n.emotion = u.emotion; else delete n.emotion;
    } else if (u.kind === "delete") {
      e.sim.byId.delete(u.id);
      setTimeout(() => { n.ringHidden = true; awake(300); }, 1400);
    }
  }

  const hasBursts = (now) => e.orbit.listBursts().some((b) => now - b.born < BURST_LIFE * 1000);
  return { apply, hasBursts };
}
