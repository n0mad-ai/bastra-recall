/** Bootstrap: load the graph, wire the managers together, hand off to the
 *  render loop. This file owns only what more than one manager needs — the
 *  view/structure state, the selection, and the view switch. Everything with
 *  a boundary of its own lives in `managers/` or `boot/`. */

import { fetchGraph, fetchAnnotations, postAnnotation, fetchSemanticSearch, clusterHues } from "./graph-data.js";
import { createSimulation } from "./simulation.js";
import { createRenderer } from "./renderer.js";
import { createInteractions } from "./interactions.js";
import { createInspector } from "./inspector.js";
import { createSearch } from "./search.js";
import { createMinimap } from "./minimap.js";
import { applyStoredTheme, createTheme } from "./boot/theme.js";
import { createRenderLoop } from "./boot/render-loop.js";
import { createLiveNodes } from "./live-nodes.js";
import { createRingView } from "./managers/ring-view.js";
import { createSemanticView } from "./managers/semantic-view.js";
import { createOrbitView } from "./managers/orbit-view.js";
import { createSearchChat } from "./managers/search-chat.js";
import { createImportDialog } from "./managers/import-dialog.js";
import { createOnboardingDialog } from "./managers/onboarding-dialog.js";
import { createAreasManager } from "./managers/areas-manager.js";
import { createLiveUpdates } from "./managers/live-updates.js";
import { createSidebarPanels } from "./managers/sidebar-panels.js";
import { createBoltDemo } from "./managers/bolt-demo.js";
import { createViewControls } from "./managers/view-controls.js";
import { createTopbarPopovers } from "./managers/topbar-popovers.js";
import { createWeather } from "./managers/weather.js";
import { createWeatherChip } from "./managers/weather-chip.js";
import { createDrillSwitcher } from "./managers/drill-switcher.js";
import { createContextMenu } from "./managers/context-menu.js";
import { createTelemetryView } from "./managers/telemetry-view.js";

const $ = (sel) => document.querySelector(sel);

const root = document.documentElement;
applyStoredTheme(root);

async function main() {
  const canvas = $("#map");
  const graph = await fetchGraph();

  if (graph.vault_name) {
    $("#vault-name").textContent = graph.vault_name;
    document.title = `${graph.vault_name} — Vault Map`;
  }

  // ── structure mode: fine clusters ↔ memory building blocks (groups).
  // A display model, not a view — but each view opens with the structure it
  // reads best in: clouds fine-grained, ring/semantic in building blocks.
  let structureMode = "clusters"; // clouds default; view switches re-apply
  for (const n of graph.nodes) n.baseCluster = n.cluster; // fine layer, kept
  const activeGrouping = () => (structureMode === "blocks" ? graph.groups : graph.clusters);
  let hues = clusterHues(activeGrouping());

  // user-arranged cloud positions survive reloads — per structure mode
  const ANCHORS_KEY = "bastra-vault-map-cluster-pos";
  const anchorsKey = () => `${ANCHORS_KEY}:${structureMode}`;
  function loadAnchors() {
    try {
      return JSON.parse(localStorage.getItem(anchorsKey()) ?? "null");
    } catch {
      return null;
    }
  }

  const sim = createSimulation(graph, innerWidth, innerHeight, loadAnchors());
  const renderer = createRenderer(canvas, sim, hues);
  renderer.resize();

  let saveTimer = 0;
  function saveAnchorsSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      localStorage.setItem(anchorsKey(), JSON.stringify(sim.anchorPositions()));
    }, 400);
  }

  const theme = createTheme({
    root,
    toggle: $("#theme-toggle"),
    renderer,
    getHues: () => hues,
    onChange: () => panels.renderLegend(), // legend dots follow the theme's ink
  });
  const { colorOf } = theme;
  const getSatLight = () => theme.satLight();

  // ── vault care (annotations worked off in an AI session) ──────
  const careMap = new Map(); // node id → entries
  function indexCare(entries) {
    careMap.clear();
    for (const a of entries) {
      const list = careMap.get(a.id) ?? [];
      list.push(a);
      careMap.set(a.id, list);
    }
  }
  indexCare(await fetchAnnotations());
  const openCareCount = () => [...careMap.values()].flat().filter((a) => !a.done).length;
  const hasOpenCare = (id) => (careMap.get(id) ?? []).some((a) => !a.done);

  // ── inspector + selection ──────────────────────────────────────
  const knownIds = new Set(sim.nodes.filter((n) => n.kind !== "ghost").map((n) => n.id));
  const inspector = createInspector($("#inspector"), $("#inspector-content"), {
    knownIds,
    clusterColorOf: colorOf,
    getCare: (id) => careMap.get(id) ?? [],
    onAnnotate: async (id, kind, note) => {
      await postAnnotation(id, kind, note);
      indexCare(await fetchAnnotations());
      panels.renderSignals();
    },
    onNavigate: (id) => {
      const n = sim.byId.get(id);
      if (n) select(n, true);
    },
  });

  // ── views: clouds (force layout) ↔ ring (computed wheel) ───────
  // All ring internals (decor, drill browser, emblem, band hit tests) live
  // in the ring-view manager; this file only orchestrates the switch and
  // owns the node-position transition.
  const VIEW_KEY = "bastra-vault-map-view";
  // the structure a view opens with: clouds carry the fine clusters, the
  // ring reads best in the six building blocks. The semantic view has no
  // structure choice at all — positions are meaning, grouping only recolors,
  // so it stays pinned to the readable block palette (switch hidden there).
  const VIEW_STRUCTURE = { clouds: "clusters", ring: "blocks", semantic: "blocks", orbit: "clusters" };
  let currentView = "clouds";
  let viewTransition = null; // { t0, ms, from, to, noFit?, done? }
  let cloudSnapshot = null; // node positions to return to

  const ringView = createRingView({
    sim,
    renderer,
    graph,
    getInteractions: () => interactions,
    getHues: () => hues,
    getSatLight,
    getStructureMode: () => structureMode,
    startTransition: (from, to) => {
      viewTransition = { t0: performance.now(), ms: 950, from, to, noFit: true };
    },
    onDrillChange: (state) => {
      drillScope = state; // legend + signals focus on the drilled area
      panels.clearClusterFilter(); // its match belongs to the previous scope
      drillSwitcher.render(state);
      panels.renderLegend();
      panels.renderSignals();
    },
  });
  let drillScope = null; // active drill state (both modes) for sidebar scoping
  const visibleNodes = () => sim.nodes.filter((n) => !n.ringHidden);

  const semanticView = createSemanticView({ sim, renderer, getInteractions: () => interactions });
  // Weather layer (#217): opt-in, off by default. Nothing is requested until
  // the user picks a place in the topbar chip. The callback goes through a
  // variable because the chip manager is created after the views it feeds;
  // touching a `const` from up here would be a TDZ error, which optional
  // chaining does NOT catch.
  let onWeatherChange = () => {};
  const weather = createWeather(() => onWeatherChange());

  const orbitView = createOrbitView({
    sim,
    renderer,
    getInteractions: () => interactions,
    getHues: () => hues,
    getSatLight,
    getWeather: () => weather.get(),
  });

  const drillSwitcher = createDrillSwitcher({ ringView });

  // Telemetry tab (#463): a scroll page over the stage, not a canvas view.
  // The canvas keeps its view underneath and comes back untouched.
  const telemetryView = createTelemetryView();
  const markViewButton = (v) =>
    $("#view-switch")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b.dataset.view === v));

  let viewLoading = false; // semantic layout fetch in flight — don't re-enter
  async function switchView(v) {
    if (v === "telemetry") {
      telemetryView.open();
      markViewButton(v);
      return;
    }
    if (telemetryView.isOpen()) {
      telemetryView.close();
      markViewButton(currentView);
    }
    if (v === currentView || viewTransition || viewLoading) return;
    // fetch the semantic layout first — it can fail (no embeddings yet),
    // and then the current view must stay untouched
    let semTargets = null;
    if (v === "semantic") {
      viewLoading = true;
      try {
        semTargets = await semanticView.enter();
      } catch (err) {
        const hint = $("#hint");
        hint.textContent = `semantic view unavailable — ${err.message}`;
        hint.classList.remove("fade");
        setTimeout(() => hint.classList.add("fade"), 5000);
        return;
      } finally {
        viewLoading = false;
      }
    }
    // capture AFTER any await — the clouds keep drifting while the layout
    // loads, and a stale snapshot would snap them back at flight start
    const from = new Map(sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    let to;
    if (currentView === "clouds") cloudSnapshot = from;
    if (currentView === "ring") ringView.exit();
    if (currentView === "semantic") semanticView.exit();
    if (currentView === "orbit") orbitView.exit();
    // every view opens in its default structure — BEFORE the enter, so the
    // ring computes its wheel over the right grouping
    if (structureMode !== VIEW_STRUCTURE[v]) applyStructure(VIEW_STRUCTURE[v]);
    $("#structure-label").hidden = $("#structure-switch").hidden = v === "semantic" || v === "orbit";
    // semantic: an der Structure-Stelle sitzt stattdessen der 2D/3D-Umschalter
    $("#semantic-mode-label").hidden = $("#semantic-mode-switch").hidden = v !== "semantic";
    if (v === "semantic") viewControls.renderSemanticModeSwitch();
    // orbit: universe/galactic-Umschalter + Galaxie-Optionen (Distance, Drift)
    viewControls.renderMindspaceControls(v);
    if (v === "ring") {
      to = ringView.enter(); // glides its own camera via flyToRing
    } else if (v === "clouds") {
      // settle the clouds OFF-SCREEN: start from the last arrangement,
      // re-anchor for the active grouping, run the physics to rest — the
      // flight target IS the final layout, so the landing hands over to the
      // live physics seamlessly instead of snapping
      for (const n of sim.nodes) {
        const p = cloudSnapshot?.get(n.id);
        if (p) {
          n.x = p.x;
          n.y = p.y;
        }
        n.vx = 0;
        n.vy = 0;
      }
      sim.regroup(loadAnchors());
      for (let i = 0; i < 220 && sim.tick(); i++);
      to = new Map(sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
      loop.claimCameraForNewLayout(); // settled layout may take the camera; no boot snap-fit
    } else if (v === "orbit") {
      to = orbitView.enter();
    } else {
      to = semTargets;
      void semanticView.enter(); // re-arm the flags a ring exit reset; cached → sync
    }
    if (v !== "ring") {
      // camera glides to the new layout WHILE the nodes fly — never an end
      // snap. Same padding/cap as fitAll, so a later settle-fit is a no-op.
      interactions.flyToBounds([...to.values()], { padding: 90, maxScale: 1.6, ms: 950 });
    }
    currentView = v;
    localStorage.setItem(VIEW_KEY, v);
    markViewButton(v);
    viewTransition = { t0: performance.now(), ms: 950, from, to, noFit: true };
  }

  $("#view-switch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-view]");
    if (b) void switchView(b.dataset.view);
  });

  /** Neighborhood of a node: itself + everything it connects to — including
   *  the unwritten connections while the semantic view is showing them. */
  function neighborhoodOf(node) {
    const pts = [node];
    const lists = currentView === "semantic" ? [sim.edges, semanticView.getEdges()] : [sim.edges];
    for (const list of lists) {
      for (const e of list) {
        if (e.s.id === node.id) pts.push(e.t);
        if (e.t.id === node.id) pts.push(e.s);
      }
    }
    return pts;
  }

  function select(node, fly = true) {
    // a stale hover (mouse parked over the canvas since before the search)
    // would win over the new focus and light up the WRONG node's strands
    renderer.setHover(null);
    // picking a memory ends the cluster-filter lens — the selection's own
    // neighborhood lighting takes over, undimmed
    if (node && panels.clearClusterFilter()) {
      panels.renderLegend();
    }
    renderer.setFocus(node);
    document.body.classList.toggle("inspector-open", node !== null);
    if (!node) {
      inspector.close();
      return;
    }
    // zoom in so the node and all its strands fill the view — inside the
    // viewport rectangle NOT covered by inspector/sidebar/topbar
    if (fly) interactions.flyToBounds(neighborhoodOf(node), { padding: 60, maxScale: 2.6 });
    inspector.show(node);
  }
  $("#inspector-close").addEventListener("click", () =>
    document.body.classList.remove("inspector-open"),
  );

  /** #307 — a category can come into EXISTENCE live, not just gain members.
   *
   *  Everything that groups the map is derived once, from the graph fetched at
   *  load: the cluster/group lists (and with them the hues and the legend),
   *  the cloud anchors in the simulation, the galaxies in the universe. A
   *  memory from an area that did not exist back then therefore arrived as a
   *  loose point and only found its cloud after a manual reload. That is
   *  exactly the onboarding case on a fresh vault, where the profile memories
   *  are what CREATES the user area — the one moment a category is born.
   *
   *  Cluster keys are APPENDED, never re-sorted: a cluster's hue is its index
   *  in this list, so a newborn category must not repaint the whole map.
   *  Counts are recounted from the live nodes, so the legend never shows a
   *  freshly created area as empty. */
  function registerLiveGrouping(node) {
    const touch = (list, key, keyOf) => {
      if (!key) return false;
      let count = 0;
      for (const n of sim.nodes) if (keyOf(n) === key) count += 1;
      const hit = list.find((c) => c.key === key);
      if (hit) {
        hit.count = count;
        return false;
      }
      list.push({ key, count });
      return true;
    };
    // both axes, regardless of the active structure mode — the other one must
    // not be missing its key when the user switches over
    const freshCluster = touch(graph.clusters, node.baseCluster, (n) => n.baseCluster ?? n.cluster);
    const freshGroup = touch(graph.groups, node.group, (n) => n.group);
    if (!freshCluster && !freshGroup && sim.centers.has(node.cluster)) return;
    hues = clusterHues(activeGrouping());
    renderer.setHues(hues);
    panels.renderLegend();
    // Only the view that is ON SCREEN has to grow the new grouping right now;
    // every other one derives it when entered (switchView regroups the clouds,
    // ringView.enter recomputes the wheel). Doing it anyway would overwrite
    // the ring's own cluster centers behind its back.
    if (currentView === "clouds") {
      // the same path the structure switch uses — the new cloud arrives
      // through the physics (animated) instead of snapping into place
      sim.regroup(loadAnchors());
      loop.markBusy();
    }
    orbitView.invalidate(); // the universe gains the galaxy the burst needs
  }

  const { adoptLiveNode, openMemoryById } = createLiveNodes({
    sim,
    inspector,
    select,
    getStructureMode: () => structureMode,
    onAdopt: registerLiveGrouping,
  });

  /** Screen areas covered by UI — fits/flights center in the free rectangle. */
  function mapInsets() {
    const inspectorOpen = !$("#inspector").hidden || document.body.classList.contains("inspector-open");
    // panel state lives in sidebar-panels.js — its applyPanelState() mirrors
    // visibility onto the body class, which is order-safe during boot
    const panelVisible = document.body.classList.contains("panel-open");
    return {
      left: inspectorOpen ? 432 : 24,
      right: panelVisible ? 286 : 46,
      top: 70,
      bottom: 40,
    };
  }

  const interactions = createInteractions(canvas, renderer, sim, {
    onSelect: (n, sx, sy) => {
      // universe: solange eine Supernova brennt, gewinnt ihr Stern jeden
      // Klick in seinem Radius — sonst öffnet der Node-Pick den nächsten
      // ÜBERLAPPENDEN Nachbarn statt des Newborns unter dem Stern
      if (currentView === "orbit" && sx !== undefined) {
        const w = renderer.toWorld(sx, sy);
        const burst = orbitView.pickBurst(w.x, w.y);
        if (burst) {
          void openMemoryById(burst.id);
          return;
        }
      }
      if (n) {
        select(n);
        return;
      }
      // ring view: headline = back, center = image picker, band = drill in
      if (currentView === "ring" && sx !== undefined) {
        if (ringView.handleClick(renderer.toWorld(sx, sy))) return;
      }
      select(null);
    },
    onClusterDragEnd: () => saveAnchorsSoon(),
    getInsets: mapInsets,
    canDragClusters: () => currentView === "clouds",
    onHoverChange: (n, x, y) => {
      const tip = $("#tooltip");
      if (!n) {
        tip.hidden = true;
        // clickable ring chrome gets a pointer: band segments (drill in),
        // headline (back), center emblem (image picker)
        if (currentView === "ring") {
          if (ringView.updateHover(renderer.toWorld(x, y))) canvas.style.cursor = "pointer";
        } else {
          ringView.clearHover();
        }
        // Live-Supernovae sind klickbar → Zeigefinger auch über dem Stern
        if (currentView === "orbit") {
          const w = renderer.toWorld(x, y);
          if (orbitView.pickBurst(w.x, w.y)) canvas.style.cursor = "pointer";
        }
        return;
      }
      tip.innerHTML = "";
      const title = document.createElement("div");
      title.className = "t-title";
      title.textContent = n.title;
      const sub = document.createElement("div");
      sub.className = "t-sub";
      sub.textContent =
        n.kind === "ghost"
          ? `unwritten · linked ${n.degree}×`
          : `${n.cluster} · ${n.type} · ${n.degree} links`;
      tip.append(title, sub);
      tip.hidden = false;
      const pad = 14;
      tip.style.left = `${Math.min(x + pad, innerWidth - tip.offsetWidth - pad)}px`;
      tip.style.top = `${Math.min(y + pad, innerHeight - tip.offsetHeight - pad)}px`;
    },
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (inspector.isOpen()) select(null);
    else if (ringView.isDrilled()) ringView.drillOut(); // Esc backs out of the area
  });

  createContextMenu({
    canvas,
    sim,
    renderer,
    inspector,
    getInteractions: () => interactions,
    select,
  });

  // ── search: instant title match + the daemon's semantic recall.
  // While the search is open the map dims/blurs, the box widens, and the
  // copilot chat docks beside the results to deepen the search.
  const searchApi = createSearch($("#search"), $("#search-results"), sim.nodes, {
    colorOf,
    onPick: (n) => select(n, true),
    aiSearch: async (q) =>
      (await fetchSemanticSearch(q)).map((h) => sim.byId.get(h.id)).filter(Boolean),
    onOpenChange: (open) => {
      $("#search-dim").classList.toggle("on", open);
      $("#searchbox").classList.toggle("expanded", open);
      searchChat.setVisible(open);
    },
  });
  const searchChat = createSearchChat({
    panel: $("#search-chat"),
    sim,
    onHits: (found) => searchApi.setAgentHits(found),
  });

  // ── import dialog: seed the vault from other AI tools, visually ──
  createImportDialog({ modal: $("#import-modal"), opener: $("#import-open") });

  // ── areas manager: create/rename/delete the vault's top-level areas ──
  createAreasManager({ modal: $("#areas-modal"), opener: $("#areas-open") });

  // ── live updates: new memories appear as supernovae + preview cards ──
  createLiveUpdates({
    orbitView,
    sim,
    renderer,
    getView: () => currentView,
    switchView,
    openMemory: openMemoryById,
    adoptNode: adoptLiveNode,
  });

  // ── mindspace recenter: one press (or C) fits the universe back in view ──
  function recenterOrbit() {
    if (currentView !== "orbit") return;
    interactions.flyToBounds(sim.nodes.map((n) => ({ x: n.x, y: n.y })), { padding: 90, maxScale: 1.6, ms: 700 });
  }
  $("#orbit-recenter").addEventListener("click", recenterOrbit);
  addEventListener("keydown", (ev) => {
    if (ev.target.matches?.("input, textarea")) return;
    if (ev.key === "c" || ev.key === "C") recenterOrbit();
  });

  // ── onboarding interview: a fresh vault offers to seed itself ──
  createOnboardingDialog({ modal: $("#onboarding-modal") });

  // ── sidebar panels: legend, signals, filters, system, panel state ──
  const panels = createSidebarPanels({
    sim,
    renderer,
    graph,
    getInteractions: () => interactions,
    getHues: () => hues,
    getSatLight,
    getDrillScope: () => drillScope,
    activeGrouping,
    visibleNodes,
    hasOpenCare,
  });

  // reset: drop the saved arrangement (of the active structure mode)
  $("#reset-layout").addEventListener("click", () => {
    clearTimeout(saveTimer); // a pending save must not resurrect the old layout
    localStorage.removeItem(anchorsKey());
    location.reload();
  });

  // ── structure switch: reassign clusters, recolor, reorganize animated ──
  /** Reassign + recolor only — no re-layout. View switches use this to apply
   *  their default structure before computing the target layout. */
  function applyStructure(mode) {
    structureMode = mode;
    $("#structure-switch")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b.dataset.structure === mode));
    for (const n of sim.nodes) n.cluster = mode === "blocks" ? n.group : n.baseCluster;
    hues = clusterHues(activeGrouping());
    renderer.setHues(hues);
    panels.clearClusterFilter(); // its keys belong to the previous grouping
    panels.renderLegend();
  }
  function setStructure(mode) {
    if (mode === structureMode || viewTransition) return;
    applyStructure(mode);
    if (currentView === "ring") {
      // structure change resets any drill and recomputes the whole wheel
      const { from, to } = ringView.refreshForStructure();
      viewTransition = { t0: performance.now(), ms: 950, from, to, noFit: true };
      cloudSnapshot = null; // stale under the new grouping
    } else if (currentView === "clouds") {
      // clouds reorganize themselves through the physics — animated by nature
      sim.regroup(loadAnchors());
      loop.markBusy();
    }
  }
  // ── view controls: semantic + mindspace mode switches (own manager) ──
  const boltDemo = createBoltDemo({ renderer, sim });
  const viewControls = createViewControls({
    sim,
    renderer,
    boltDemo,
    semanticView,
    orbitView,
    weather,
    getInteractions: () => interactions,
    getCurrentView: () => currentView,
    isBusy: () => Boolean(viewTransition),
    setTransition: (t) => (viewTransition = t),
  });
  const weatherChip = createWeatherChip({ weather });
  onWeatherChange = () => weatherChip.render();
  createTopbarPopovers();

  $("#structure-switch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-structure]");
    if (b) setStructure(b.dataset.structure);
  });
  $("#structure-switch")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.structure === structureMode));

  // ── minimap ────────────────────────────────────────────────────
  const minimap = createMinimap($("#minimap"), sim, renderer, colorOf, (x, y, s, ms) =>
    interactions.flyTo(x, y, s, ms),
  );

  // ── render loop (boot/render-loop.js owns the frame + camera warmup) ──
  const loop = createRenderLoop({
    canvas,
    sim,
    renderer,
    minimap,
    ringView,
    orbitView,
    semanticView,
    getInteractions: () => interactions,
    getView: () => currentView,
    getTransition: () => viewTransition,
    setTransition: (t) => (viewTransition = t),
    saveAnchorsSoon,
  });
  loop.start();
  // Mindspace (the universe) is the home view — first visit lands there;
  // afterwards the last-used view wins as before
  const savedView = localStorage.getItem(VIEW_KEY) ?? "orbit";
  if (savedView === "ring" || savedView === "semantic" || savedView === "orbit") void switchView(savedView);

  // ── choreography/demo runner (opt-in via ?demo=1) ──────────────
  // A self-running show for filming the map on a phone. It drives the real
  // functions above — no fork, no fake canvas. The normal app is completely
  // untouched unless the flag is set. Scene timeline lives in js/demo.js.
  const demoFlag = new URLSearchParams(location.search).get("demo");
  if (demoFlag !== null && demoFlag !== "0") {
    const drive = {
      switchView, getView: () => currentView, select, openMemoryById,
      recenterOrbit, sim, renderer, interactions, orbitView, boltDemo,
    };
    window.__vault = drive; // also handy for hand-tuning the show from the console
    import("./demo.js")
      .then((m) => m.runDemo(drive))
      .catch((err) => console.error("[demo] load failed", err));
  }

  setTimeout(() => $("#hint").classList.add("fade"), 6000);
}

main().catch((err) => {
  const hint = document.querySelector("#hint");
  hint.textContent = `could not load the vault graph — is the daemon running? (${err.message})`;
  hint.classList.remove("fade");
});
