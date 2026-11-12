// Footer timeline, variant "console": quick filter + 52 weekly bars with a
// draggable range. Other footer variants follow in the agent step.
import { h, clear, setVars } from "./dom.js";
import { t, numberFmt, LANG } from "./i18n.js";
import { state, setState } from "./state.js";
import { data } from "./data.js";

const SEL = { all: 52, 90: 13, 30: 4, 7: 1 };
let tl, opts, sum, barsEl, brush, axis, chart, vsep, drag = false;

export function mountFooter(app) {
  opts = h("div.tl__opts");
  sum = h("span.tl__sum");
  barsEl = h("div.tl__bars");
  brush = h("span.tl__brush", null,
    h("span.tl__grip.tl__grip--l", { title: t("tl.dragStart"), on: { pointerdown: grip("L") } }),
    h("span.tl__grip.tl__grip--r", { title: t("tl.dragEnd"), on: { pointerdown: grip("R") } }),
    h("span.tl__brush-pin"));
  axis = h("div.tl__axis");
  vsep = h("span.tl__vsep");
  chart = h("div.tl__chart", null, barsEl, axis);
  tl = h("div.tl", null, h("div.tl__in", null, h("div.tl__ctl", null, opts, sum), vsep, chart));
  app.append(tl);
}

function range() {
  const sel = SEL[state.time] ?? 52;
  return state.brush ? [state.brush.a, state.brush.b] : [52 - sel, 52];
}

function grip(side) {
  return (e) => {
    e.preventDefault(); e.stopPropagation();
    const rc = barsEl.getBoundingClientRect();
    const [a0, b0] = range();
    drag = true; brush.classList.add("is-drag");
    const mv = (ev) => {
      const w = Math.round(Math.min(1, Math.max(0, (ev.clientX - rc.left) / rc.width)) * 52);
      const c = state.brush || { a: a0, b: b0 };
      setState({ brush: side === "L" ? { a: Math.min(w, c.b - 1), b: c.b } : { a: c.a, b: Math.max(w, c.a + 1) } });
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); drag = false; brush.classList.remove("is-drag"); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
}

function weekLabel(w) {
  if (!data.weekStart) return "";
  const d = new Date(data.weekStart.getTime() + w * 7 * 864e5);
  return d.toLocaleDateString(LANG === "de" ? "de-DE" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
}

export function render(L) {
  tl.hidden = !L.showTimeline;
  if (!L.showTimeline) return;
  clear(opts).append(h("span.tl__lab", { text: t("tl.updated") }),
    ...[["all", t("tl.all")], ["90", "90d"], ["30", "30d"], ["7", "7d"]].map(([v, label]) =>
      h("button.tl__opt", { cls: !state.brush && String(state.time) === v ? "is-on" : "", text: label, on: { click: () => setState({ time: v, brush: null }) } })));
  const [a, b] = range();
  const weeks = data.weeks.length === 52 ? data.weeks : new Array(52).fill(0);
  const inRange = weeks.slice(a, b).reduce((x, y) => x + y, 0);
  const n = numberFmt.format(inRange);
  sum.textContent = state.brush ? t("tl.range", { n, a: weekLabel(a), b: b === 52 ? t("tl.now") : weekLabel(b) })
    : state.time === "all" ? t("tl.allTime", { n: numberFmt.format(data.health?.vault_size ?? inRange) }) : t("tl.inDays", { n, d: state.time });
  const barsOn = state.vw - (L.jL + L.podW + 12) - 24 >= 520;
  vsep.hidden = !barsOn; chart.hidden = !barsOn;
  if (!barsOn) return;
  const max = Math.max(1, ...weeks);
  clear(barsEl).append(...weeks.map((v, i) => h("span.tl__bar", { cls: i >= a && i < b ? (b - a === 52 ? "is-all" : "is-in") : "", vars: { "--h": `${(3 + (v / max) * 17).toFixed(1)}px` }, title: `${weekLabel(i)} · ${v}` })),
    brush, h("span.tl__now"));
  brush.classList.toggle("is-cut", b < 52);
  setVars(brush, { "--b-l": `${(a / 52) * 100}%`, "--b-r": `${((52 - b) / 52) * 100}%` });
  if (!drag) brush.classList.remove("is-drag");
  const ticks = [0, 13, 26, 39].map(weekLabel);
  clear(axis).append(...ticks.map((x) => h("span", { text: x })), h("span", { text: t("tl.now") }));
}
