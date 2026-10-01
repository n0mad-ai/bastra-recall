/** Sidebar panels — legend, signals, filters, system health, panel state
 *  (collapse/pin/accordions). Split out of app.js (file-size convention):
 *  everything the right-hand sidebar owns lives here. The pieces other code
 *  pokes (cluster-filter release, re-renders after drill/theme changes) are
 *  returned as small methods. */

import { fetchHealth, clusterColor } from "../graph-data.js";

const $ = (sel) => document.querySelector(sel);

export function createSidebarPanels(deps) {
  const {
    sim,
    renderer,
    graph,
    getInteractions,
    getHues,
    getSatLight,
    getDrillScope,
    activeGrouping,
    visibleNodes,
    hasOpenCare,
  } = deps;

  // ── legend + panels ────────────────────────────────────────────
  const legendEl = $("#legend");
  let clusterFilter = null; // { key, match } — the legend's click-toggle filter
  function renderLegend() {
    legendEl.innerHTML = "";
    // inside a drill the legend focuses on the wheel's segments; the numbers
    // and hover/click targets are the drilled area, not the whole vault
    const drillScope = getDrillScope();
    const scoped = drillScope !== null;
    const items = scoped ? drillScope.segments : activeGrouping();
    for (const c of items) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot";
      const [sat, light] = getSatLight();
      dot.style.background = clusterColor(getHues(), c.key, sat, light);
      dot.style.color = dot.style.background;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = c.key;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = c.count;
      li.append(dot, name, count);
      const match = scoped
        ? (n) => drillScope.matchKey(n) === c.key
        : (n) => n.cluster === c.key;
      li.classList.toggle("active", clusterFilter?.key === c.key);
      li.addEventListener("mouseenter", () => renderer.setHighlight(match, scoped ? null : c.key));
      li.addEventListener("mouseleave", () => renderer.setHighlight(null));
      // click = toggle a persistent cluster filter (ANDed with the other
      // filters): another entry switches over, the same entry releases.
      // Selecting a node on the map releases it too (see select()).
      li.addEventListener("click", () => {
        const on = clusterFilter?.key !== c.key;
        clusterFilter = on ? { key: c.key, match } : null;
        applyFilter();
        renderLegend();
        if (!on) return;
        if (scoped) {
          getInteractions().flyToBounds(visibleNodes().filter(match), { padding: 80, maxScale: 2.4 });
        } else {
          getInteractions().flyToCluster(c.key);
        }
      });
      legendEl.append(li);
    }
  }
  renderLegend();

  // ── filters: clickable signals + time range, combined with AND ──
  let signalKey = null; // "memories" | "ghosts" | "bridges" | "care" | null
  let timeDays = null; // 7 | 30 | 90 | null
  function applyFilter() {
    if (signalKey === null && timeDays === null && clusterFilter === null) {
      renderer.setFilter(null);
      return;
    }
    const cutoff = timeDays
      ? new Date(Date.now() - timeDays * 86400e3).toISOString().slice(0, 10)
      : null;
    renderer.setFilter((n) => {
      if (clusterFilter !== null && !clusterFilter.match(n)) return false;
      if (cutoff !== null && !(n.updated && n.updated >= cutoff)) return false;
      if (signalKey === "memories" && n.kind === "ghost") return false;
      if (signalKey === "ghosts" && n.kind !== "ghost") return false;
      if (signalKey === "bridges" && !n.bridge) return false;
      if (signalKey === "care" && !hasOpenCare(n.id)) return false;
      return true;
    });
  }

  const kv = (k, v, ok = false) =>
    `<li><span class="k">${k}</span><span class="v${ok ? " ok" : ""}">${v}</span></li>`;

  function renderSignals() {
    // signals always describe what is ON the map right now — inside a drill
    // that is the drilled area, not the whole vault
    const vis = visibleNodes();
    const visIds = new Set(vis.map((n) => n.id));
    const ghosts = vis.filter((n) => n.kind === "ghost").length;
    const bridges = vis.filter((n) => n.bridge).length;
    const edges = sim.edges.filter((e) => visIds.has(e.s.id) && visIds.has(e.t.id)).length;
    const care = vis.filter((n) => hasOpenCare(n.id)).length;
    const rows = [
      // This counts nodes ON THE MAP right now (drilled area, minus
      // ghosts) — a different number from the topbar's vault-wide
      // `#stat-count`, which includes private memories the map never draws.
      // Same word on both read as one measurement; "on map" names which one.
      { key: "memories", label: "memories on map", value: vis.length - ghosts },
      { key: null, label: "connections", value: edges },
      { key: "ghosts", label: "unwritten notes", value: ghosts },
      { key: "bridges", label: "bridge nodes", value: bridges },
      { key: "care", label: "care flags", value: care },
    ];
    const ul = $("#signals");
    ul.innerHTML = "";
    for (const r of rows) {
      const li = document.createElement("li");
      if (r.key) {
        li.className = `filterable${signalKey === r.key ? " active" : ""}`;
        li.title = "Click to filter the map";
        li.addEventListener("click", () => {
          signalKey = signalKey === r.key ? null : r.key;
          applyFilter();
          renderSignals();
        });
      }
      li.innerHTML = `<span class="k">${r.label}</span><span class="v">${r.value}</span>`;
      ul.append(li);
    }
  }
  renderSignals();

  $("#time-filter").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-days]");
    if (!btn) return;
    timeDays = btn.dataset.days === "" ? null : Number(btn.dataset.days);
    $("#time-filter").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    applyFilter();
  });

  $("#stat-count").textContent = `${graph.vault_size} memories`;

  fetchHealth().then((h) => {
    if (!h) return;
    $("#system").innerHTML =
      kv("daemon", `v${h.version}`, true) +
      kv("semantic recall", h.semantic_recall, h.semantic_recall === "on") +
      kv("embedding", h.embedding_mode);
    // prefill the bug-report form with the same sanitized block `bastra
    // feedback bug` sends — version/OS/embedding/vault size, never content
    const diag = [
      `version:    ${h.version}`,
      `os:         ${navigator.platform}`,
      `embedding:  ${h.embedding_mode}`,
      `vault_size: ${h.vault_size}`,
      `via:        vault map`,
    ].join("\n");
    const params = new URLSearchParams({
      template: "bug_report.yml",
      "bastra-version": h.version,
      os: navigator.platform,
      "doctor-output": diag,
    });
    $("#feedback-bug").href = `https://github.com/n0mad-ai/bastra-recall/issues/new?${params.toString()}`;
  });

  // ── sidebar state: collapsed / pinned / accordion, persisted ────
  const PANEL_KEY = "bastra-vault-map-panel";
  let panelState = { collapsed: false, pinned: false, closed: {} };
  try {
    panelState = { ...panelState, ...JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}") };
  } catch { /* defaults */ }
  const panel = $("#system-panel");
  function applyPanelState() {
    panel.classList.toggle("pinned", panelState.pinned);
    panel.classList.toggle("collapsed", !panelState.pinned && panelState.collapsed);
    document.body.classList.toggle("panel-pinned", panelState.pinned);
    // Live-Cards + History docken an die linke Kante der sichtbaren Sidebar
    document.body.classList.toggle("panel-open", panelState.pinned || !panelState.collapsed);
    document.querySelectorAll(".panel-section[data-acc]").forEach((sec) => {
      sec.classList.toggle("closed", Boolean(panelState.closed[sec.dataset.acc]));
    });
  }
  function savePanelState() {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panelState));
  }
  applyPanelState();

  $("#panel-handle").addEventListener("click", () => {
    panelState.collapsed = !panelState.collapsed;
    applyPanelState();
    savePanelState();
  });
  $("#panel-pin").addEventListener("click", () => {
    panelState.pinned = !panelState.pinned;
    if (panelState.pinned) panelState.collapsed = false;
    applyPanelState();
    savePanelState();
  });
  document.querySelectorAll(".panel-section[data-acc] .acc-head").forEach((head) => {
    head.addEventListener("click", () => {
      const sec = head.closest(".panel-section");
      panelState.closed[sec.dataset.acc] = !sec.classList.contains("closed");
      applyPanelState();
      savePanelState();
    });
  });


  /** Release the legend's click filter (select / drill / structure change
   *  invalidate its match). Returns true when a filter was actually set. */
  function clearClusterFilter() {
    if (clusterFilter === null) return false;
    clusterFilter = null;
    applyFilter();
    return true;
  }

  return { renderLegend, renderSignals, applyFilter, clearClusterFilter };
}
