// Lens views (Chronos, Radiant, Spiral, Half-life, Weave): canvas + zoom bar,
// memory card with arm after the click glide, numbered hit marks.
import { h, clear } from "../dom.js";
import { state, setState, subscribe } from "../state.js";
import { onData } from "../data.js";
import { vault, timeWindow, inWindow, windowKey, areaCol } from "./vault-data.js";
import { mountLens } from "./lens-canvas.js";
import { zoomBar, overlay, memoryCard, dock, TC, INK } from "./chrome.js";
import { mountMemoryBrowser } from "./memory-browser.js";

export function mountLensView(kind, stage) {
  const canvas = h("canvas.lv__cv");
  const box = h("div.lv", null, canvas);
  const zb = zoomBar({ onIn: () => lens.zoomBy(1.4), onOut: () => lens.zoomBy(1 / 1.4), onFit: () => lens.reset() });
  stage.append(box, zb.el);
  const ov = overlay(stage);
  const cardHost = h("div");
  stage.append(cardHost);
  const unMb = mountMemoryBrowser(stage, { showMemory: (id) => lens.open(id) });

  let shown = null,
    shownFor = "",
    card = null,
    selMem = null;
  function items() {
    const v = vault();
    if (!v) return null;
    const key = windowKey();
    if (shown && shownFor === key && shown.src === v) return shown.list;
    const win = timeWindow();
    shown = { src: v, list: v.mems.filter((m) => inWindow(m, win)) };
    shownFor = key;
    return shown.list;
  }
  const opts = () => ({
    kind,
    vault: items(),
    focus: state.focus || null,
    hoverArea: state.hover || null,
    areaColor: areaCol,
  });

  const lens = mountLens(canvas, {
    ...opts(),
    onOpen: (id) => {
      const m = vault()?.byId.get(id);
      if (!m) return;
      selMem = m;
      buildCard();
      place();
    },
    onArea: (a) => setState({ focus: state.focus === a ? null : a }),
    onHoverArea: (a) => setState({ hover: a }),
    onZoom: (p) => zb.set(p),
    onFrame: () => place(),
  });

  function buildCard() {
    clear(cardHost);
    card = null;
    if (!selMem) {
      ov.arm(null);
      return;
    }
    card = memoryCard(selMem, { onClose: closeCard });
    cardHost.append(card.el);
  }
  // closing glides back to the fit (as the zoom bar's fit button)
  function closeCard() {
    selMem = null;
    lens.reset();
    buildCard();
  }
  const onKey = (e) => {
    if (e.key === "Escape" && selMem && !state.covered) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeCard();
    }
  };
  window.addEventListener("keydown", onKey, true);

  function place() {
    const b = stage.getBoundingClientRect(),
      W = b.width,
      H = b.height;
    if (card) {
      const sp = lens.selScreen();
      if (!sp || sp[2] !== selMem.id) {
        ov.arm(null);
      } else {
        const [ax, ay] = sp,
          right = ax < W * 0.6,
          m = right ? -Math.PI / 4 : (-3 * Math.PI) / 4;
        const ex = ax + Math.cos(m) * 26,
          ey = ay + Math.sin(m) * 26;
        dock(card, ov, {
          ax,
          ay,
          ex,
          ey,
          right,
          x: right ? ex + 40 : ex - 40 - 260,
          W,
          H,
          color: TC[selMem.cls] || INK,
        });
      }
    }
    const hits = Array.isArray(state.hits) ? state.hits : [];
    ov.marks(
      hits
        .slice(0, 3)
        .map((id, i) => ({ n: i + 1, p: lens.screenOf(id) }))
        .filter((m) => m.p)
        .map((m) => ({ n: m.n, x: m.p[0], y: m.p[1] }))
    );
  }

  let prev = { ...state },
    prevWin = windowKey();
  const unsub = subscribe((st) => {
    const ch = (k) => st[k] !== prev[k];
    if (ch("focus") && selMem) closeCard();
    if (ch("focus") || ch("hover") || windowKey() !== prevWin)
      lens.update({ ...opts(), replay: windowKey() !== prevWin });
    if (ch("hits")) place();
    prev = { ...st };
    prevWin = windowKey();
  });
  // Live vault update: new drawing data in place (no entrance sweep, zoom and
  // selection stay). An open card follows its memory: same content → kept as
  // is, changed → refilled without the entrance fade, deleted → closed.
  const sig = (m) => [m.title, m.area, m.cls, m.at, m.recalled, m.links.length, m.summary].join("\u0001");
  let seenV = vault();
  const unData = onData(() => {
    const v = vault();
    if (!v || v === seenV) return;
    seenV = v;
    lens.update(opts());
    if (!selMem) return;
    const m = v.byId.get(selMem.id);
    if (!m) {
      closeCard();
      return;
    }
    const was = sig(selMem);
    selMem = m;
    if (sig(m) !== was) {
      buildCard();
      card.el.classList.add("is-swap");
      place();
    }
  });

  return () => {
    window.removeEventListener("keydown", onKey, true);
    unMb();
    unsub();
    unData();
    lens.destroy();
  };
}
