// Shared parts of the vault views (prototype STAGE block): zoom bar, focus
// card with its connecting arm (DESIGN-SYSTEM §1.8), numbered hit marks.
import { h, s, clear, setVars } from "../dom.js";
import { t, numberFmt } from "../i18n.js";
import { setState } from "../state.js";
import { ask } from "../agent.js";
import { vault, areaCol, recentIn, ago } from "./vault-data.js";

export const ACC = "#38d9f5", AMB = "#d9a441", INK = "#d7e3f4", MUT = "#7d92a8";
/** Display class colours (memory-lenses.js TC, prototype TYPE_COLOR). */
export const TC = { decision: ACC, fact: INK, rule: AMB, convention: AMB, note: MUT, reference: "#a0b4cd" };

/** Zoom bar, bottom right (prototype `zoomable`). */
export function zoomBar({ onIn, onOut, onFit }) {
  const pct = h("span.zbar__pct", { text: "100%" });
  const fit = h("button.zbar__fit", { title: t("vv.zoomFit"), on: { click: onFit } },
    s("svg", { viewBox: "0 0 16 16" }, s("path", { d: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4", fill: "none", stroke: "currentColor", "stroke-width": "1.4" })));
  const el = h("div.zbar", null,
    h("button.zbar__btn", { title: t("vv.zoomOut"), text: "−", on: { click: onOut } }), pct,
    h("button.zbar__btn", { title: t("vv.zoomIn"), text: "+", on: { click: onIn } }), fit);
  return { el, set(p) { pct.textContent = `${p}%`; el.classList.toggle("is-zoomed", p > 100); } };
}

/** Arm layer (polyline + anchor ring) and the numbered marks layer. */
export function overlay(stage) {
  const line = s("polyline", { fill: "none", "stroke-width": "1" });
  const dot = s("circle", { r: "3.5", fill: "#060a13", "stroke-width": "1.4" });
  const svg = s("svg.vv-arm", { width: "100%", height: "100%" }, line, dot);
  const marks = h("div.vv-marks");
  stage.append(svg, marks);
  return {
    arm(pts, color) {
      svg.classList.toggle("is-on", !!pts);
      if (!pts) return;
      line.setAttribute("points", pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
      line.setAttribute("stroke", color); dot.setAttribute("stroke", color);
      dot.setAttribute("cx", pts[0][0].toFixed(1)); dot.setAttribute("cy", pts[0][1].toFixed(1));
    },
    /** marks: [{ n, x, y }] in stage pixels; keeps existing spans so the pop-in plays once. */
    marks(list) {
      const key = list.map((m) => m.n).join(",");
      if (marks.dataset.k !== key) { marks.dataset.k = key; clear(marks).append(...list.map((m) => h("span.vv-mark", { text: String(m.n) }))); }
      list.forEach((m, i) => setVars(marks.children[i], { "--x": `${(m.x - 13).toFixed(0)}px`, "--y": `${(m.y - 13).toFixed(0)}px` }));
    },
  };
}

function shell(color, onClose, kicker) {
  const side = h("span.vcard__side");
  const el = h("div.vcard", { vars: { "--fc": color } }, side,
    h("div.vcard__head", null, kicker, h("button.vcard__esc", { "aria-label": t("vv.close"), text: t("vv.esc"), on: { click: onClose } })));
  return { el, side };
}

/** Area card (prototype `insp`): rank, name, three stats, recent memories, actions. */
export function areaCard(key, { compact, onMemory }) {
  const v = vault(), color = areaCol(key);
  const idx = v.areas.findIndex((a) => a.key === key), area = v.areas[idx];
  const count = area ? area.count : 0;
  const { el, side } = shell(color, () => setState({ focus: null }), h("span.vcard__k", { text: t("vv.area", { r: `${String(idx + 1).padStart(2, "0")}/${v.areas.length}` }) }));
  const stat = (val, lab) => h("span.vcard__stat", null, h("span.vcard__sv", { text: val }), h("span.vcard__sl", { text: lab }));
  el.append(
    h("div.vcard__name", { text: key }),
    h("div.vcard__stats", null, stat(numberFmt.format(count), t("vv.memories")), stat(`${((count / Math.max(1, v.total)) * 100).toFixed(1)}%`, t("vv.ofVault")), stat(numberFmt.format(v.linksOf(key)), t("vv.links"))),
    h("div.vcard__list", null, recentIn(key, compact ? 2 : 3).map((m) => h("button.vcard__mem", { on: { click: () => onMemory(m) } },
      h("span.vcard__sq", { vars: { "--tc": TC[m.cls] || INK } }), h("span.vcard__mt", { text: m.title }), h("span.vcard__ago", { text: Number.isFinite(m.at) ? ago(m.at) : "" })))),
    h("div.vcard__acts", null,
      h("button.vcard__open", { text: t("vv.openBrowser"), title: t("vv.browserWip"), on: { click: () => setState({ toast: t("vv.browserWip") }) } }),
      h("button.vcard__ask", { text: t("vv.ask"), on: { click: () => ask(t("vv.askArea", { a: key })) } })));
  return { el, side };
}

/** Memory card: one memory, opened by a click in a lens or in the ring card. */
export function memoryCard(m, { onClose }) {
  const c = TC[m.cls] || INK;
  const { el, side } = shell(c, onClose, h("span.vcard__chip", { text: t(`vv.cls.${m.cls}`), vars: { "--tc": c } }));
  el.querySelector(".vcard__head").insertBefore(h("span.vcard__area", { text: m.area }), el.querySelector(".vcard__esc"));
  const date = Number.isFinite(m.at) ? dateStr(m.at) : "";
  el.append(
    h("div.vcard__title", { text: m.title }),
    h("div.vcard__meta", { text: [date, t("vv.recalledN", { n: m.recalled }), t("vv.linksN", { n: m.links.length })].filter(Boolean).join(" · ") }),
    m.summary ? h("p.vcard__sum", { text: m.summary }) : null,
    h("div.vcard__acts", null, h("button.vcard__ask", { text: t("vv.ask"), on: { click: () => ask(t("vv.askMemory", { m: m.title })) } })));
  return { el, side };
}

export function dateStr(ms) {
  return new Date(ms).toLocaleDateString(document.documentElement.lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Dock a card to an anchor (prototype ring focus geometry, renderValsDark):
 * arm = anchor → elbow (ex, ey) → card edge; the side accent line runs
 * symmetrically around the docking point (DESIGN-SYSTEM §1.8).
 * When the card cannot sit beside the elbow (the ring fills the stage), it is
 * placed below (or above) the elbow and the arm docks on that edge instead,
 * so the arm never runs underneath the card.
 */
export function dock(card, ov, { ax, ay, ex, ey, right, x, W, H, color }) {
  const cardH = card.el.offsetHeight || 300, CW = 260;
  x = Math.max(0, Math.min(x, W - CW));
  const side = card.side;
  side.classList.remove("is-left", "is-right", "is-top", "is-bottom");
  // Keep the card clear of the zoom bar (bottom right: 142 × 30 px + 12 px margins).
  const Hx = (cx0) => (cx0 + CW > W - 154 ? H - 54 : H);
  if (right ? x >= ex + 8 : x + CW <= ex - 8) {
    const y = Math.max(0, Math.min(ey - 28, Hx(x) - cardH));
    const lx = right ? x : x + CW;
    const pts = [[ax, ay], [ex, ey], [lx, ey]];
    const outside = ey < y || ey > y + cardH;
    if (outside) pts.push([lx, y + 14]);
    const hitY = outside ? y + 14 : ey;
    setVars(card.el, { "--cx": `${x}px`, "--cy": `${y}px` });
    side.classList.add(right ? "is-left" : "is-right");
    setVars(side, { "--sh": `${Math.min(cardH, Math.max(2, 2 * (hitY - y) + 1)).toFixed(0)}px` });
    ov.arm(pts, color);
    return;
  }
  const cx = Math.max(0, Math.min(ex - CW / 2, W - CW)), Hb = Hx(cx);
  const below = ey + 24 + cardH <= Hb || ey < Hb / 2;
  const y = below ? Math.max(0, Math.min(ey + 24, Hb - cardH)) : Math.max(0, ey - 24 - cardH);
  const dx = Math.max(14, Math.min(CW - 14, ex - cx));
  setVars(card.el, { "--cx": `${cx}px`, "--cy": `${y}px` });
  if (!below) { side.classList.add("is-bottom"); setVars(side, { "--sx": `${(dx - Math.min(dx, CW - dx)).toFixed(0)}px`, "--sw": `${(2 * Math.min(dx, CW - dx) + 1).toFixed(0)}px` }); }
  ov.arm([[ax, ay], [ex, ey], [cx + dx, ey], [cx + dx, below ? y : y + cardH]].filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]), color);
}

/** Card without an anchor: top right (prototype else-branch). */
export function park(card, ov, W) {
  setVars(card.el, { "--cx": `${Math.max(0, W - 280)}px`, "--cy": "10px" });
  card.side.classList.remove("is-left", "is-right", "is-top", "is-bottom");
  ov.arm(null);
}

