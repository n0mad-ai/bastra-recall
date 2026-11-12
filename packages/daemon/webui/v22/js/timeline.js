// Timeline pieces shared by every footer variant: quick filter, summary, axis
// and the graph (bars | pulse) with a draggable range (prototype brushDown).
import { h, s, clear, setVars } from "./dom.js";
import { t, numberFmt, LANG } from "./i18n.js";
import { state, setState } from "./state.js";
import { data } from "./data.js";

const SEL = { all: 52, 90: 13, 30: 4, 7: 1 };
const OPTS = [["all", "tl.all"], ["90", "90d"], ["30", "30d"], ["7", "7d"]];

// An area may replace what the timeline shows while it is open (Telemetry:
// window 1d/7d/30d/90d over its own 52 bars). Source shape:
// { label(), opts() → [[value, text, on, busy]], pick(value), range() → [a, b],
//   weeks() → 52 numbers, barTitle(i, v), summary(), axis(kind) → strings }.
const sources = new Map();
export function registerTimelineSource(view, src) { sources.set(view, src); }
const src = () => sources.get(state.view);

/** Label in front of the quick filter ("UPDATED" / "WINDOW"). */
export function timeLabel() { return src()?.label() ?? t("tl.updated"); }

export function range() {
  if (src()) return src().range();
  const sel = SEL[state.time] ?? 52;
  return state.brush ? [state.brush.a, state.brush.b] : [52 - sel, 52];
}

export function weeks() { if (src()) return src().weeks(); return data.weeks.length === 52 ? data.weeks : new Array(52).fill(0); }

function weekLabel(w) {
  if (!data.weekStart) return "";
  const d = new Date(data.weekStart.getTime() + w * 7 * 864e5);
  return d.toLocaleDateString(LANG === "de" ? "de-DE" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
}

/** Quick-filter buttons (prototype timeOpts). */
export function timeOpts(el) {
  const S = src();
  if (S) {
    // busy: the window being loaded right now (sweep, js/sections/loading.js)
    clear(el).append(...S.opts().map(([v, text, on, busy]) => h("button.tl__opt", { cls: [on ? "is-on" : "", busy ? "ld-on" : ""].join(" "), "aria-busy": busy ? "true" : null, text, on: { click: () => S.pick(v) } })));
    return el;
  }
  clear(el).append(...OPTS.map(([v, k]) =>
    h("button.tl__opt", { cls: !state.brush && String(state.time) === v ? "is-on" : "", text: k.startsWith("tl.") ? t(k) : k, on: { click: () => setState({ time: v, brush: null }) } })));
  return el;
}

/** Range summary (prototype timeLabel). */
export function summary() {
  if (src()) return src().summary();
  const [a, b] = range();
  const n = numberFmt.format(weeks().slice(a, b).reduce((x, y) => x + y, 0));
  return state.brush ? t("tl.range", { n, a: weekLabel(a), b: b === 52 ? t("tl.now") : weekLabel(b) })
    : state.time === "all" ? t("tl.allTime", { n: numberFmt.format(data.health?.vault_size ?? weeks().reduce((x, y) => x + y, 0)) }) : t("tl.inDays", { n, d: state.time });
}

/** Axis tick: month in caps without dots ("NOV 25" for the first, then "FEB"). */
function monthLabel(w, year) {
  if (!data.weekStart) return "";
  const d = new Date(data.weekStart.getTime() + w * 7 * 864e5);
  const opt = year ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "short", timeZone: "UTC" };
  return d.toLocaleDateString(LANG === "de" ? "de-DE" : "en-US", opt).replace(/\./g, "").toUpperCase();
}

/** Axis labels: "full" = five ticks, "short" = first + now, "mirror" = first, summary, now. */
export function axis(el, kind) {
  if (src()) {
    const l = src().axis(kind);
    clear(el).append(...l.slice(0, -1).map((x, i) => h(kind === "mirror" && i === 1 ? "span.tl__axis-sum" : "span", { text: x })), h("span.tl__axis-now", { text: l[l.length - 1] }));
    return;
  }
  const now = h("span.tl__axis-now", { text: t("tl.now").toUpperCase() });
  const parts = kind === "short" ? [h("span", { text: monthLabel(0, true) })]
    : kind === "mirror" ? [h("span", { text: monthLabel(0, true) }), h("span.tl__axis-sum", { text: summary() })]
    : [0, 13, 26, 39].map((w) => h("span", { text: monthLabel(w, w === 0) }));
  clear(el).append(...parts, now);
}

/**
 * One timeline graph. variant: console | mirror | island | drawer (sets the
 * per-variant modifiers in footer.css). The element is kept across renders so
 * the range transitions stay smooth; update() redraws the data.
 */
export function makeGraph(variant) {
  const el = h(`div.tg.tg--${variant}`);
  let mode = "", bars = null, base = null, win = null, inner = null, dot = null, drag = false;

  const grips = () => [
    h("span.tl__grip.tl__grip--l", { title: t("tl.dragStart"), on: { pointerdown: grip("L") } }),
    h("span.tl__grip.tl__grip--r", { title: t("tl.dragEnd"), on: { pointerdown: grip("R") } }),
  ];

  function grip(side) {
    return (e) => {
      e.preventDefault(); e.stopPropagation();
      const rc = el.getBoundingClientRect();
      const [a0, b0] = range();
      drag = true; win.classList.add("is-drag");
      const mv = (ev) => {
        const w = Math.round(Math.min(1, Math.max(0, (ev.clientX - rc.left) / rc.width)) * 52);
        const c = state.brush || { a: a0, b: b0 };
        setState({ brush: side === "L" ? { a: Math.min(w, c.b - 1), b: c.b } : { a: c.a, b: Math.max(w, c.a + 1) } });
      };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); drag = false; win.classList.remove("is-drag"); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    };
  }

  function pulseSvg(cls, grad) {
    const svg = s(`svg.${cls}`, { viewBox: "0 0 1000 100", preserveAspectRatio: "none" });
    if (grad) svg.append(s("defs", null, s("linearGradient", { id: grad, x1: 0, y1: 0, x2: 0, y2: 1 },
      s("stop", { offset: 0, "stop-opacity": grad === "ftpg" ? ".22" : ".38" }), s("stop", { offset: 1, "stop-opacity": "0" }))));
    svg.append(s("path.pl__area", grad ? { fill: `url(#${grad})` } : null), s("path.pl__line", { "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
    return svg;
  }

  function build(m) {
    mode = m;
    if (m === "pulse") {
      const grad = variant === "console";
      base = pulseSvg("pl__base", grad ? "ftpg" : "");
      inner = pulseSvg("pl__inner", grad ? "ftpg2" : "");
      win = h("div.pl__win", null, grips(), inner);
      dot = variant === "mirror" ? null : h("span.pl__dot");
      bars = null;
      el.className = `tg tg--${variant} tg--pulse`;
      clear(el).append(base, win);
      if (dot) el.append(dot);
    } else {
      bars = h("div.tb__bars");
      win = h("span.tl__brush", null, grips(), h("span.tl__brush-pin"));
      el.className = `tg tg--${variant} tg--bars`;
      clear(el).append(bars, win);
      if (variant === "console") el.append(h("span.tl__now"));
    }
  }

  function update(m) {
    if (m !== mode) build(m);
    const S = src();
    el.classList.toggle("tg--fixed", !!S);
    const [a, b] = range();
    const vals = weeks(), max = Math.max(1, ...vals);
    if (m === "pulse") {
      const pts = vals.map((v, i) => [(i / (vals.length - 1)) * 1000, 96 - (v / max) * 84]);
      const line = pts.map((q, i) => (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" ");
      const area = line + " L1000 100 L0 100 Z";
      for (const svg of [base, inner]) { svg.querySelector(".pl__area").setAttribute("d", area); svg.querySelector(".pl__line").setAttribute("d", line); }
      const bl = (a / 52) * 100, br = ((52 - b) / 52) * 100, wf = Math.max(0.02, 1 - bl / 100 - br / 100);
      setVars(inner, { "--inv-w": `${(100 / wf).toFixed(2)}%`, "--inv-l": `${(-(bl / 100) / wf * 100).toFixed(2)}%` });
      if (dot) setVars(dot, { "--now-y": `${pts[pts.length - 1][1].toFixed(1)}%` });
    } else {
      const pct = variant !== "console";
      clear(bars).append(...vals.map((v, i) => h("span.tl__bar", {
        cls: i >= a && i < b ? (b - a === 52 ? "is-all" : "is-in") : "",
        vars: { "--h": pct ? `${Math.max(6, (v / max) * 100).toFixed(1)}%` : `${(3 + (v / max) * 17).toFixed(1)}px` },
        title: S ? S.barTitle(i, v) : `${weekLabel(i)} · ${v}` })));
    }
    win.classList.toggle("is-cut", b < 52);
    if (!drag) win.classList.remove("is-drag");
    setVars(win, { "--b-l": `${(a / 52) * 100}%`, "--b-r": `${((52 - b) / 52) * 100}%` });
  }

  return { el, update };
}
