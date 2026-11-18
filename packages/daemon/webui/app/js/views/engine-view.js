// web UI frame around the old map engines (Mindspace, Clouds, Semantic):
// zoom bar, info card with connecting arm, numbered hit marks, hover tip,
// area focus/hover and the footer time window as engine filters, and the
// "View" tab of the right panel. The engines themselves run in engine-host.js.
import { h, clear, setVars } from "../dom.js";
import { t } from "../i18n.js";
import { state, setState, subscribe } from "../state.js";
import { data, onData } from "../data.js";
import { vault, timeWindow, windowKey, areaCol, typeClass } from "./vault-data.js";
import { zoomBar, overlay, areaCard, memoryCard, dock, park, TC, INK } from "./chrome.js";
import { mountMemoryBrowser } from "./memory-browser.js";
import { attach, engine } from "./engine-host.js";
import { signalMatch } from "./signals.js";
import { CORES } from "../../engines/managers/orbit-core.js";
import { weatherPicker } from "../weather-place.js";
import { loadingBlock } from "../sections/loading.js";

/** web UI view id → engine view id (old UI data-view). */
export const ENGINE_VIEW = { mindspace: "orbit", clouds: "clouds", semantic: "semantic" };

const base = (n) => n.baseCluster ?? n.cluster;
const CARD_COL = 290; // right column for the info card (260 px card + margins)

/** Card model for a node; nodes outside the web UI vault model (unwritten
 *  ghosts, skills) get a minimal one built from the engine node. */
function memOf(n) {
  const m = vault()?.byId.get(n.id);
  if (m) return m;
  const at = Date.parse(typeof n.updated === "string" ? n.updated : "");
  const e = engine.get(),
    links = [];
  if (e) for (const x of e.sim.edges) if (x.s.id === n.id || x.t.id === n.id) links.push(x);
  return {
    id: n.id,
    title: n.title,
    area: base(n),
    cls: n.kind === "ghost" ? "note" : typeClass(n.type),
    summary: n.kind === "ghost" ? t("ev.ghostSum") : n.summary,
    at: Number.isFinite(at) ? at : NaN,
    recalled: 0,
    links,
  };
}

export function mountEngineView(id, stage) {
  const zb = zoomBar({
    onIn: () => engine.zoomBy(1.4),
    onOut: () => engine.zoomBy(1 / 1.4),
    onFit: () => engine.fit(),
  });
  const tipT = h("span.ev-tip__t"),
    tipS = h("span.ev-tip__s");
  const tip = h("div.ev-tip", { hidden: true }, tipT, tipS);
  const note = h("div.ev-note", { hidden: true });
  const hint = h("div.ev-hint");
  stage.append(zb.el, tip, note, hint);
  const ov = overlay(stage);
  const cardHost = h("div");
  stage.append(cardHost);
  // memory browser over this view; "show" flies to the memory (old select())
  const unMb = mountMemoryBrowser(stage, {
    showMemory: (mid) => {
      const n = engine.get()?.sim.byId.get(mid);
      if (n) pick(n);
    },
  });

  let detach = null,
    sel = null,
    selM = null,
    card = null,
    cardKey = "",
    pct = -1,
    dead = false,
    waiting = false,
    loader = null;

  // Until the view is entered the engine would still draw the previous view's
  // layout (Semantic loads its layout for seconds, Clouds settles ~1 s of
  // physics on its first entry): the canvas stays hidden and the run
  // indicator covers the stage (css/views.css › .ev-wait; it fades in after a
  // short wait, so quick switches do not flash).
  function loading(on) {
    stage.classList.toggle("ev-wait", on);
    if (on && !loader) {
      loader = h("div.ld-stage.ev-load", null, loadingBlock(t("ev.loading")));
      stage.append(loader);
    }
    if (!on && loader) {
      loader.remove();
      loader = null;
    }
  }

  function start() {
    if (detach || waiting || dead || !data.graph) return;
    waiting = true;
    loading(true);
    // two frames: the indicator is painted before a synchronous engine entry blocks
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        waiting = false;
        if (dead || detach) return;
        detach = attach(stage, ENGINE_VIEW[id], {
          onSelect: pick,
          onHover: hover,
          onFrame: place,
          onReady: () => {
            loading(false);
            note.hidden = true;
            look();
          },
          onError: (err) => {
            loading(false);
            note.hidden = false;
            note.textContent = t("ev.semUnavailable", { e: err?.message || String(err) });
          },
        });
        engine.freeze(state.covered); // a memory browser already open over this view
        if (state.focus) engine.hold(true); // an area opened before this view keeps it still
        look();
      })
    );
  }

  // ── engine look: area focus = cluster filter, area hover = preview, footer
  // window = time filter (the old sidebar legend + time filter, ANDed) ──────
  function look() {
    const e = engine.get();
    if (!e || !detach) return;
    // area focus, footer window and the Signals tile (old sidebar filters, ANDed)
    const focus = state.focus,
      win = timeWindow(),
      sig = signalMatch(state.signal);
    const inWin = (n) => {
      const at = Date.parse(typeof n.updated === "string" ? n.updated : "");
      return Number.isFinite(at) && at >= win[0] && at < win[1];
    };
    e.renderer.setFilter(
      !focus && !win && !sig ? null : (n) => (!focus || base(n) === focus) && (!win || inWin(n)) && (!sig || sig(n))
    );
    const hv = state.hover;
    e.renderer.setHighlight(hv ? (n) => base(n) === hv : null, hv && e.structure === "clusters" ? hv : null);
    engine.wake(300);
  }

  function members(key) {
    const e = engine.get();
    return e ? e.sim.nodes.filter((n) => base(n) === key) : [];
  }

  function pick(n) {
    const e = engine.get();
    if (!n) {
      if (sel) closeMem();
      return;
    }
    // picking a memory ends the area focus (old select()), then lights its neighbourhood
    sel = null;
    if (state.focus) setState({ focus: null });
    sel = n;
    selM = memOf(n);
    e.renderer.setHover(null);
    e.renderer.setFocus(n);
    engine.hold(true); // Mindspace stops turning so the card can be read
    const pts = [n];
    const lists = e.view === "semantic" ? [e.sim.edges, e.semantic.getEdges()] : [e.sim.edges];
    for (const list of lists)
      for (const x of list) {
        if (x.s.id === n.id) pts.push(x.t);
        if (x.t.id === n.id) pts.push(x.s);
      }
    // the card docks in a column on the right; the neighbourhood fits beside it
    engine.setCardInset(CARD_COL);
    engine.flyTo(pts, { padding: 60, maxZoom: 2.4 });
    tip.hidden = true;
  }

  /** refit: back out to the centred default view (as the zoom bar's fit);
   *  false when an area focus takes the camera right after. */
  function closeMem(refit = true) {
    sel = null;
    engine.setCardInset(0);
    engine.get()?.renderer.setFocus(null);
    engine.hold(!!state.focus); // an open area card keeps the hold
    if (refit) engine.fit();
    engine.wake(300);
  }

  function hover(n, x, y) {
    if (!n || !engine.get()?.rect) {
      tip.hidden = true;
      return;
    }
    tipT.textContent = n.title;
    tipS.textContent =
      n.kind === "ghost" ? t("ev.tipGhost", { n: n.degree }) : t("ev.tipMem", { a: base(n), t: n.type, n: n.degree });
    tip.hidden = false;
    const b = stage.getBoundingClientRect(),
      w = tip.offsetWidth,
      hh = tip.offsetHeight;
    setVars(tip, {
      "--x": `${Math.max(0, Math.min(x - b.left + 14, b.width - w - 8)).toFixed(0)}px`,
      "--y": `${Math.max(0, Math.min(y - b.top + 14, b.height - hh - 8)).toFixed(0)}px`,
    });
  }

  // ── card, arm and hit marks; runs after every drawn frame ────────────────
  function place() {
    const e = engine.get();
    if (!e || !e.rect || dead) return;
    const p = engine.zoomPct();
    if (p !== pct) {
      pct = p;
      zb.set(p);
    }
    // navigation hint (old UI #orbit-hint / #semantic-hint): drag rotates in depth views
    const hk =
      e.view === "orbit" || (e.view === "semantic" && engine.semanticMode() === "3d")
        ? "ev.hintDepth"
        : e.view === "clouds"
          ? "ev.hintClouds"
          : "ev.hintFlat";
    if (hint.dataset.k !== hk) {
      hint.dataset.k = hk;
      hint.textContent = t(hk);
    }
    const W = e.rect.right - e.rect.left,
      H = e.rect.bottom - e.rect.top;
    const key = sel ? `m|${sel.id}` : state.focus ? `a|${state.focus}|${H < 420}` : "";
    if (key !== cardKey) {
      cardKey = key;
      clear(cardHost);
      card = null;
      if (sel) card = memoryCard(selM, { onClose: () => closeMem() });
      else if (state.focus && vault())
        card = areaCard(state.focus, {
          compact: H < 420,
          onMemory: (m) => {
            const n = e.sim.byId.get(m.id);
            if (n) pick(n);
          },
        });
      if (card) cardHost.append(card.el);
    }
    if (card) {
      let ax = NaN,
        ay = NaN,
        right = true;
      if (sel) {
        [ax, ay] = engine.toStage(sel.x, sel.y);
        right = ax < W * 0.6;
      } else {
        // area: dock at the cloud's outer edge on the card side, so the card
        // does not cover the area it describes
        let x0 = Infinity,
          x1 = -Infinity,
          sy = 0,
          c = 0;
        for (const n of members(state.focus)) {
          if (n.ringHidden) continue;
          const [x, y] = engine.toStage(n.x, n.y);
          if (x < 0 || x > W || y < 0 || y > H) continue;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          sy += y;
          c++;
        }
        if (c) {
          right = (x0 + x1) / 2 < W - CARD_COL;
          ax = right ? x1 : x0;
          ay = sy / c;
        }
      }
      if (!(ax >= 0 && ax <= W && ay >= 0 && ay <= H)) park(card, ov, W, H);
      else {
        const m = right ? -Math.PI / 4 : (-3 * Math.PI) / 4;
        const ex = ax + Math.cos(m) * 26,
          ey = ay + Math.sin(m) * 26;
        const x = sel ? (right ? ex + 40 : ex - 40 - 260) : right ? W - CARD_COL + 18 : 12;
        dock(card, ov, { ax, ay, ex, ey, right, x, W, H, color: sel ? TC[selM.cls] || INK : areaCol(state.focus) });
      }
    } else ov.arm(null);
    const hits = Array.isArray(state.hits) ? state.hits : [];
    ov.marks(
      hits
        .slice(0, 3)
        .map((hid, i) => ({ n: i + 1, node: e.sim.byId.get(hid) }))
        .filter((m) => m.node && !m.node.ringHidden)
        .map((m) => {
          const [x, y] = engine.toStage(m.node.x, m.node.y);
          return { n: m.n, x, y };
        })
        .filter((m) => m.x >= 0 && m.x <= W && m.y >= 0 && m.y <= H)
    );
  }

  const onKey = (ev) => {
    if (ev.key === "Escape" && sel && !state.covered) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closeMem();
    }
  };
  window.addEventListener("keydown", onKey, true);

  let prev = { ...state },
    prevWin = windowKey();
  const unsub = subscribe((st) => {
    const ch = (k) => st[k] !== prev[k];
    if (ch("covered")) engine.freeze(st.covered); // js/cover.js: nothing moves under a covering layer
    if (ch("focus")) {
      if (sel) closeMem(!st.focus);
      engine.hold(!!st.focus); // an open area card stops the turning, as a memory card does
      engine.setCardInset(st.focus ? CARD_COL : 0);
      if (st.focus) engine.flyTo(members(st.focus), { padding: 90, maxScale: 2.4, ms: 850 });
    }
    if (ch("focus") || ch("hover") || ch("signal") || ch("careN") || windowKey() !== prevWin) look();
    prev = { ...st };
    prevWin = windowKey();
    engine.wake(600); // layout changes (panels) move the stage; hits move the marks
  });
  const unData = onData(() => start());
  start();

  return () => {
    dead = true;
    loading(false);
    unMb();
    unsub();
    unData();
    window.removeEventListener("keydown", onKey, true);
    if (detach) detach();
  };
}

// ── right panel › View (prototype viewRows) ───────────────────────────────
const TIME = [
  ["all", "tl.all"],
  ["90", "90d"],
  ["30", "30d"],
  ["7", "7d"],
];

export function viewTab(id) {
  return function render(body) {
    const draw = () => {
      const rows = [];
      const seg = (opts, cur, onPick) =>
        h(
          "div.vt__seg",
          null,
          opts.map(([v, key]) =>
            h("button", {
              type: "button",
              cls: v === cur ? "is-on" : "",
              text: t(key),
              on: {
                click: () => {
                  onPick(v);
                  setTimeout(draw, 0);
                },
              },
            })
          )
        );
      const row = (labelKey, el, list = rows) => list.push(h("span.vt__l", { text: t(labelKey) }), el);
      if (id === "mindspace") {
        const m = engine.orbitMode();
        row(
          "ev.mode",
          seg(
            [
              ["universe", "ev.universe"],
              ["galaxy", "ev.galactic"],
            ],
            m,
            engine.setOrbitMode
          )
        );
        row(
          "ev.lab",
          seg(
            [
              ["universe-lab", "ev.universeLab"],
              ["galaxy-lab", "ev.milkyWay"],
            ],
            m,
            engine.setOrbitMode
          )
        );
        // the centre graphic exists only where there is a centre: both galactic modes
        if (m === "galaxy" || m === "galaxy-lab") {
          const sel = h(
            "select.vt__sel",
            {
              "aria-label": t("ev.core"),
              on: {
                change: () => {
                  engine.setCore(sel.value);
                },
              },
            },
            Object.entries(CORES).map(([k, c]) => h("option", { value: k, text: c.name }))
          );
          sel.value = engine.core();
          row("ev.core", sel);
        }
        row(
          "ev.distance",
          seg(
            [
              ["woven", "ev.woven"],
              ["balanced", "ev.balanced"],
            ],
            engine.distance(),
            engine.setDistance
          )
        );
        row(
          "ev.drift",
          seg(
            [
              ["on", "ev.on"],
              ["off", "ev.off"],
            ],
            engine.drift() ? "on" : "off",
            (v) => engine.setDrift(v === "on")
          )
        );
        row("ev.weather", weatherPicker(engine.weather(), draw));
      } else if (id === "semantic") {
        const m = engine.semanticMode();
        row(
          "ev.structure",
          seg(
            [
              ["2d", "ev.flat"],
              ["3d", "ev.depth"],
            ],
            m,
            engine.setSemanticMode
          )
        );
        // the engine's opt-in auto-spin (depth only): visible and off by default
        if (m === "3d")
          row(
            "ev.spin",
            seg(
              [
                ["on", "ev.on"],
                ["off", "ev.off"],
              ],
              engine.spin() ? "on" : "off",
              (v) => engine.setSpin(v === "on")
            )
          );
      } else {
        row(
          "ev.structure",
          seg(
            [
              ["clusters", "ev.clusters"],
              ["blocks", "ev.blocks"],
            ],
            engine.structure(),
            engine.setStructure
          )
        );
      }
      row(
        "ev.updated",
        seg(TIME, state.brush ? "" : state.time, (v) => setState({ time: v, brush: null }))
      );

      // ── Activity flares (old sidebar › Activity): how a live flare travels ──
      const flares = [];
      const style = engine.boltStyle(),
        sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
      const sum = h("span.vt__s", { text: style === "off" ? t("ev.off") : `${style} · ${sec(engine.boltMs())}` });
      row(
        "ev.style",
        seg(
          [
            ["bolt", "ev.bolt"],
            ["pulse", "ev.pulse"],
            ["trace", "ev.trace"],
            ["off", "ev.off"],
          ],
          style,
          engine.setBoltStyle
        ),
        flares
      );
      const slider = (min, max, step, value, fmt, onIn) => {
        const out = h("span.vt__rv", { text: fmt(value) });
        const inp = h("input.vt__range", {
          type: "range",
          min,
          max,
          step,
          value,
          on: {
            input: () => {
              onIn(Number(inp.value));
              out.textContent = fmt(Number(inp.value));
              sum.textContent =
                engine.boltStyle() === "off" ? t("ev.off") : `${engine.boltStyle()} · ${sec(engine.boltMs())}`;
            },
          },
        });
        return h("div.vt__slide", null, inp, out);
      };
      row("ev.duration", slider(300, 4000, 100, engine.boltMs(), sec, engine.setBoltMs), flares);
      row(
        "ev.spread",
        slider(
          0,
          100,
          5,
          Math.round(engine.boltSpread() * 100),
          (v) => `${v}%`,
          (v) => engine.setBoltSpread(v / 100)
        ),
        flares
      );
      row(
        "ev.demo",
        seg(
          [
            ["on", "ev.on"],
            ["off", "ev.off"],
          ],
          engine.demo() ? "on" : "off",
          (v) => engine.setDemo(v === "on")
        ),
        flares
      );

      clear(body).append(
        h(
          "div.vt",
          null,
          h(
            "div.vt__head",
            null,
            h("span.vt__h", { text: t("ev.display") }),
            h("span.vt__k", { text: t(`view.${id}`) })
          ),
          h("div.vt__grid", null, rows),
          h("div.vt__head", null, h("span.vt__h", { text: t("ev.flares") }), sum),
          h("div.vt__grid", null, flares),
          id === "clouds"
            ? h("button.vt__reset", {
                type: "button",
                title: t("ev.resetTitle"),
                text: t("ev.reset"),
                on: { click: () => engine.resetLayout() },
              })
            : null
        )
      );
    };
    draw();
  };
}
