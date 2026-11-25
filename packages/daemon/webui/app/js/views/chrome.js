// Shared parts of the vault views (prototype STAGE block): zoom bar, focus
// card with its connecting arm (DESIGN-SYSTEM §1.8), numbered hit marks.
import { h, s, clear, setVars } from "../dom.js";
import { t, numberFmt } from "../i18n.js";
import { setState } from "../state.js";
import { ask } from "../agent.js";
import { vault, areaCol, recentIn, ago } from "./vault-data.js";
import { openMemoryBrowser } from "./memory-browser.js";
import { dockGeometry, ZB_W, ZB_H } from "./dock-geometry.js";
import { ghostActions } from "./ghost-actions.js";

export const ACC = "#38d9f5",
  AMB = "#d9a441",
  INK = "#d7e3f4",
  MUT = "#7d92a8";
/** Display class colours (memory-lenses.js TC, prototype TYPE_COLOR). */
export const TC = { decision: ACC, fact: INK, rule: AMB, convention: AMB, note: MUT, reference: "#a0b4cd" };
/** Link colours by relation (vault-data.js REL: written | derived). */
export const RC = { linked: INK, derived: MUT };

/** Zoom bar, bottom right (prototype `zoomable`). */
export function zoomBar({ onIn, onOut, onFit }) {
  const pct = h("span.zbar__pct", { text: "100%" });
  const fit = h(
    "button.zbar__fit",
    { title: t("vv.zoomFit"), on: { click: onFit } },
    s(
      "svg",
      { viewBox: "0 0 16 16" },
      s("path", {
        d: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.4",
      })
    )
  );
  const el = h(
    "div.zbar",
    null,
    h("button.zbar__btn", { title: t("vv.zoomOut"), text: "−", on: { click: onOut } }),
    pct,
    h("button.zbar__btn", { title: t("vv.zoomIn"), text: "+", on: { click: onIn } }),
    fit
  );
  return {
    el,
    set(p) {
      pct.textContent = `${p}%`;
      el.classList.toggle("is-zoomed", p > 100);
    },
  };
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
      line.setAttribute("stroke", color);
      dot.setAttribute("stroke", color);
      dot.setAttribute("cx", pts[0][0].toFixed(1));
      dot.setAttribute("cy", pts[0][1].toFixed(1));
    },
    /** marks: [{ n, x, y }] in stage pixels; keeps existing spans so the pop-in plays once. */
    marks(list) {
      const key = list.map((m) => m.n).join(",");
      if (marks.dataset.k !== key) {
        marks.dataset.k = key;
        clear(marks).append(...list.map((m) => h("span.vv-mark", { text: String(m.n) })));
      }
      list.forEach((m, i) =>
        setVars(marks.children[i], { "--x": `${(m.x - 13).toFixed(0)}px`, "--y": `${(m.y - 13).toFixed(0)}px` })
      );
    },
  };
}

function shell(color, onClose, kicker) {
  const side = h("span.vcard__side");
  const el = h(
    "div.vcard",
    { vars: { "--fc": color } },
    side,
    h(
      "div.vcard__head",
      null,
      kicker,
      h("button.vcard__esc", { "aria-label": t("vv.close"), text: t("vv.esc"), on: { click: onClose } })
    )
  );
  return { el, side };
}

// A single short texture wave on pointer entry. No pointermove loop, timers or
// click effect: resting over a button leaves only its quiet CSS hover surface.
function actionButton(cls, key, click) {
  return h(`button.${cls}`, {
    type: "button",
    text: t(key),
    on: {
      click,
      pointerenter: (e) => {
        if (e.pointerType === "touch" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const button = e.currentTarget,
          r = button.getBoundingClientRect();
        const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
        const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
        const radius = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y));
        setVars(button, { "--ripple-x": `${x}px`, "--ripple-y": `${y}px`, "--ripple-size": `${radius * 2}px` });
        button.classList.add("is-rippling");
      },
      pointerleave: (e) => e.currentTarget.classList.remove("is-rippling"),
      animationend: (e) => {
        if (e.animationName === "vcard-ripple") e.currentTarget.classList.remove("is-rippling");
      },
    },
  });
}

/** One memory row of a card list (class square, title, age); click → onMemory(m). */
const memRow = (m, onMemory) =>
  h(
    "button.vcard__mem",
    { on: { click: () => onMemory(m) } },
    h("span.vcard__sq", { vars: { "--tc": TC[m.cls] || INK } }),
    h("span.vcard__mt", { text: m.title }),
    h("span.vcard__ago", { text: Number.isFinite(m.at) ? ago(m.at) : "" })
  );

/** Area card (prototype `insp`): rank, name, three stats, recent memories, actions. */
export function areaCard(key, { compact, onMemory }) {
  const v = vault(),
    color = areaCol(key);
  const idx = v.areas.findIndex((a) => a.key === key),
    area = v.areas[idx];
  const count = area ? area.count : 0;
  const { el, side } = shell(
    color,
    () => setState({ focus: null }),
    h("span.vcard__k", { text: t("vv.area", { r: `${String(idx + 1).padStart(2, "0")}/${v.areas.length}` }) })
  );
  const stat = (val, lab) =>
    h("span.vcard__stat", null, h("span.vcard__sv", { text: val }), h("span.vcard__sl", { text: lab }));
  el.append(
    h("div.vcard__name", { text: key }),
    h(
      "div.vcard__stats",
      null,
      stat(numberFmt.format(count), t("vv.memories")),
      stat(`${((count / Math.max(1, v.total)) * 100).toFixed(1)}%`, t("vv.ofVault")),
      stat(numberFmt.format(v.linksOf(key)), t("vv.links"))
    ),
    h(
      "div.vcard__list",
      null,
      recentIn(key, compact ? 2 : 3).map((m) => memRow(m, onMemory))
    ),
    h(
      "div.vcard__acts",
      null,
      actionButton("vcard__open", "vv.openBrowser", (e) =>
        openMemoryBrowser(key, null, e.currentTarget.getBoundingClientRect())
      ),
      actionButton("vcard__ask", "vv.ask", () => ask(t("vv.askArea", { a: key })))
    )
  );
  return { el, side };
}

/**
 * Memory card: one memory, opened by a click in a lens or in the ring card.
 * An unwritten memory (kind "ghost") has no text: the card says so and, with
 * `onMemory`, lists the memories that link to it; its own action row queues
 * it for writing or marks it as a skill (ghost-actions.js).
 */
export function memoryCard(m, { onClose, onMemory }) {
  const c = TC[m.cls] || INK;
  const { el, side } = shell(c, onClose, h("span.vcard__chip", { text: t(`vv.cls.${m.cls}`), vars: { "--tc": c } }));
  el.querySelector(".vcard__head").insertBefore(
    h("span.vcard__area", { text: m.area }),
    el.querySelector(".vcard__esc")
  );
  const date = Number.isFinite(m.at) ? dateStr(m.at) : "";
  el.append(
    h("div.vcard__title", { text: m.title }),
    h("div.vcard__meta", {
      text: [date, t("vv.recalledN", { n: m.recalled }), t("vv.linksN", { n: m.links.length })]
        .filter(Boolean)
        .join(" · "),
    }),
    ...[
      m.kind === "ghost" && h("p.vcard__sum", { text: t("ev.ghostSum") }),
      m.summary && h("p.vcard__sum", { text: m.summary }),
      m.kind === "ghost" && onMemory && referrers(m, onMemory),
      ...(m.kind === "ghost" ? ghostActions(m, actionButton) : []),
    ].filter(Boolean),
    h(
      "div.vcard__acts",
      null,
      // memory browser, opened on this memory out of the clicked button (not for ghosts / skills)
      vault()?.byId.get(m.id)
        ? actionButton("vcard__open", "vv.openBrowser", (e) =>
            openMemoryBrowser(m.area, m.id, e.currentTarget.getBoundingClientRect())
          )
        : null,
      actionButton("vcard__ask", "vv.ask", () => ask(t("vv.askMemory", { m: m.title })))
    )
  );
  return { el, side };
}

// memories that link to an unwritten one, as a scrolling card list
function referrers(m, onMemory) {
  const v = vault();
  return h(
    "div.vcard__list.is-refs",
    null,
    h("div.vcard__lh", { text: t("vv.linkedFrom") }),
    m.links
      .map((l) => v?.byId.get(l.id))
      .filter(Boolean)
      .map((x) => memRow(x, onMemory))
  );
}

export function dateStr(ms) {
  return new Date(ms).toLocaleDateString(document.documentElement.lang === "de" ? "de-DE" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Dock a card to an anchor (prototype ring focus geometry, renderValsDark):
 * arm = anchor → elbow (ex, ey) → card edge; the side accent line runs
 * symmetrically around the docking point (DESIGN-SYSTEM §1.8). The geometry
 * (dock-geometry.js) keeps the arm off the card at every zoom and pan.
 */
export function dock(card, ov, { ax, ay, ex, ey, right, x, W, H, color }) {
  // An anchor outside the stage (panned or zoomed away) gets no arm.
  if (!(ax >= 0 && ax <= W && ay >= 0 && ay <= H)) {
    park(card, ov, W, H);
    return;
  }
  const cardH = card.el.offsetHeight || 300,
    CW = card.el.offsetWidth || 350;
  const g = dockGeometry({ ax, ay, ex, ey, right, x, W, H, CW, cardH });
  const side = card.side;
  side.classList.remove("is-left", "is-right", "is-top", "is-bottom");
  if (g.side) side.classList.add(g.side);
  setVars(side, g.sideVars);
  setVars(card.el, { "--cx": `${g.x}px`, "--cy": `${g.y}px` });
  ov.arm(g.pts, color);
  reveal(card);
}

/** Card without an anchor: top right (prototype else-branch). */
export function park(card, ov, W, H = Infinity) {
  // too tall to end above the zoom bar: move left of it
  const CW = card.el.offsetWidth || 350;
  const x = 10 + card.el.offsetHeight > H - ZB_H ? W - ZB_W - CW : W - CW - 20;
  setVars(card.el, { "--cx": `${Math.max(0, x)}px`, "--cy": "10px" });
  card.side.classList.remove("is-left", "is-right", "is-top", "is-bottom");
  ov.arm(null);
  reveal(card);
}

// Cards open out of the spot the user pressed (a ring segment, a dot, a
// row): once per card, its first placement starts the card at the press
// point, scaled down, and grows it into place (transform + opacity only).
let press = null;
window.addEventListener(
  "pointerdown",
  (e) => {
    press = { x: e.clientX, y: e.clientY, at: performance.now() };
  },
  true
);
/** The last pointer press, if it was within the last second. */
export const lastPress = () => (press && performance.now() - press.at < 1000 ? press : null);
function reveal(card) {
  if (card.el.dataset.rv) return;
  card.el.dataset.rv = "1";
  const p = lastPress();
  if (!p) return;
  const r = card.el.getBoundingClientRect();
  setVars(card.el, {
    "--fx": `${(p.x - (r.left + r.width / 2)).toFixed(1)}px`,
    "--fy": `${(p.y - (r.top + r.height / 2)).toFixed(1)}px`,
  });
  card.el.classList.add("is-from");
}
