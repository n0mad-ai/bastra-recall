/** View controls — the sidebar's per-view mode switches: Semantic flat/depth
 *  and Mindspace universe/galactic (+ distance/drift options). Split out of
 *  app.js (file-size convention). app.js calls the two render functions on
 *  every view switch; the click handlers live here with the views they steer. */

import { CORES } from "./orbit-core.js";

const $ = (sel) => document.querySelector(sel);

export function createViewControls(deps) {
  const { sim, renderer, boltDemo, semanticView, orbitView, getInteractions, getCurrentView, isBusy, setTransition } =
    deps;

  // Semantic 2D/3D (zzallirog): dritter PCA-Kanal + vorhandene Kamera. Der
  // Umschalter sitzt an der Structure-Stelle, die im Semantic-View frei ist.
  function renderSemanticModeSwitch() {
    const m = semanticView.getMode();
    $("#semantic-mode-switch")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b.dataset.smode === m));
  }
  $("#semantic-mode-switch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-smode]");
    if (!b || getCurrentView() !== "semantic" || isBusy()) return;
    if (b.dataset.smode === semanticView.getMode()) return;
    const from = new Map(sim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    semanticView.setMode(b.dataset.smode);
    renderSemanticModeSwitch();
    const to = semanticView.targetsForMode(b.dataset.smode);
    getInteractions().flyToBounds([...to.values()], { padding: 90, maxScale: 1.6, ms: 700 });
    setTransition({ t0: performance.now(), ms: 700, from, to, noFit: true });
  });

  // ── Mindspace-Modus: universe (Default) / galactic — plus Galaxie-Optionen.
  // Der galaktische Umbau (User-Wolke als schwarzes Loch im Zentrum) ist
  // OPT-IN; Distance und Drift sind Anzeigeoptionen darunter.
  function renderMindspaceControls(v = getCurrentView()) {
    const inOrbit = v === "orbit";
    $("#mindspace-mode-label").hidden = $("#mindspace-mode-switch").hidden = !inOrbit;
    $("#mindspace-lab-label").hidden = $("#mindspace-lab-switch").hidden = !inOrbit;
    // the distance/drift options steer the SHIPPED galactic ring packing only —
    // galaxy-lab has no rings to order, so they stay hidden there
    $("#mindspace-galaxy-opts").hidden = !inOrbit || orbitView.getMode() !== "galaxy";
    // the core switcher applies to whatever draws a centre: both galactic modes
    const galactic = orbitView.getMode() === "galaxy" || orbitView.getMode() === "galaxy-lab";
    $("#mindspace-core-label").hidden = $("#mindspace-core-select").hidden = !inOrbit || !galactic;
    document
      .querySelectorAll("#mindspace-mode-switch button, #mindspace-lab-switch button")
      .forEach((b) => b.classList.toggle("active", b.dataset.mmode === orbitView.getMode()));
    $("#mindspace-distance-switch")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b.dataset.mdist === orbitView.getDistanceMode()));
    $("#mindspace-drift-switch")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b.dataset.mdrift === (orbitView.getDrift() ? "on" : "off")));
  }
  const onModeClick = (ev) => {
    const b = ev.target.closest("button[data-mmode]");
    if (!b || getCurrentView() !== "orbit" || isBusy()) return;
    if (b.dataset.mmode === orbitView.getMode()) return;
    orbitView.setMode(b.dataset.mmode);
    orbitView.relayout();
    renderMindspaceControls();
  };
  $("#mindspace-mode-switch").addEventListener("click", onModeClick);
  $("#mindspace-lab-switch").addEventListener("click", onModeClick);
  $("#mindspace-distance-switch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-mdist]");
    if (!b || getCurrentView() !== "orbit" || isBusy()) return;
    if (b.dataset.mdist === orbitView.getDistanceMode()) return;
    orbitView.setDistanceMode(b.dataset.mdist);
    orbitView.relayout();
    renderMindspaceControls();
  });
  // Core switcher: options come straight from the CORES registry, so adding a
  // centre graphic is one entry in orbit-core.js and nothing here. Swapping is
  // decor only — no relayout, the next frame draws the other core.
  {
    const sel = $("#mindspace-core-select");
    for (const [key, { name }] of Object.entries(CORES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = name;
      sel.append(opt);
    }
    sel.value = orbitView.getCore();
    sel.addEventListener("change", () => {
      // setCore reports whether the choice changed the LAYOUT (gravity web) or
      // only the drawing; only the former needs a rebuild.
      if (orbitView.setCore(sel.value)) orbitView.relayout();
    });
  }

  $("#mindspace-drift-switch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-mdrift]");
    if (!b) return;
    orbitView.setDrift(b.dataset.mdrift === "on");
    renderMindspaceControls();
  });

  // ── Activity: how a live flare travels its connections (bolt-styles.js).
  // Unlike the switches above this one is view-independent — flares happen in
  // every view — so it stays visible and is rendered once at startup.
  function renderBoltStyleSwitch() {
    $("#bolt-style-switch")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b.dataset.bolt === renderer.getBoltStyle()));
  }
  $("#bolt-style-switch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-bolt]");
    if (!b || b.dataset.bolt === renderer.getBoltStyle()) return;
    renderer.setBoltStyle(b.dataset.bolt);
    renderBoltStyleSwitch();
  });
  renderBoltStyleSwitch();

  // Duration slider: zzallirog asked for "longer, parallel, rather than a short
  // blast" — but the right length is taste, not a constant, so it moves here
  // instead of into a second hardcoded number. Applies to every style; the
  // level stagger scales with it, so a slow discharge keeps its rhythm.
  function renderBoltSpeed() {
    const ms = renderer.getBoltMs();
    $("#bolt-speed").value = String(ms);
    $("#bolt-speed-value").textContent = `${(ms / 1000).toFixed(1)}s`;
  }
  $("#bolt-speed").addEventListener("input", (ev) => {
    renderer.setBoltMs(Number(ev.target.value));
    renderBoltSpeed();
  });
  renderBoltSpeed();

  // Ausschlag-Regler: wie weit der Zacken den Strang verlässt. 0 heißt, die
  // Entladung läuft exakt auf der Verbindung — wer die weiten Zacken nicht
  // mag, zieht sie damit auf die Linie. Wirkt nur auf "bolt"; pulse und trace
  // laufen ohnehin auf dem Strang.
  function renderBoltSpread() {
    const v = renderer.getBoltSpread();
    $("#bolt-spread").value = String(Math.round(v * 100));
    $("#bolt-spread-value").textContent = `${Math.round(v * 100)}%`;
  }
  $("#bolt-spread").addEventListener("input", (ev) => {
    renderer.setBoltSpread(Number(ev.target.value) / 100);
    renderBoltSpread();
  });
  renderBoltSpread();

  // Dauerauslöser: keeps firing flares so the styles above can be compared
  // without querying the vault. Starts off on every load — see bolt-demo.js.
  function renderBoltDemoSwitch() {
    $("#bolt-demo-switch")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b.dataset.bdemo === (boltDemo.isRunning() ? "on" : "off")));
  }
  $("#bolt-demo-switch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-bdemo]");
    if (!b) return;
    if (b.dataset.bdemo === "on") boltDemo.start();
    else boltDemo.stop();
    renderBoltDemoSwitch();
  });

  return { renderSemanticModeSwitch, renderMindspaceControls, renderBoltStyleSwitch, renderBoltDemoSwitch };
}
