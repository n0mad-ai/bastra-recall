// Task reports — the jump list (Daniel 18.11.2026: "the scroller in the right sidebar"). It is a
// tab of the existing right panel (js/lens.js), which the Tasks area fills while the reading view is
// open (tasks.js); showing and hiding it is the panel's own collapse button and state. On top the
// report's headings, below them the block "Questions" with each question's state (open: an empty
// square in the accent colour; answered: filled amber, the colour of the owner's notes) and the
// count. A click scrolls the report to that place; while the report scrolls, the place being read
// is marked. Headings come from the Markdown structure, questions from the "[? … | …]" marker
// (annotateReport in tasks-report-notes.js) — never from words.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { hereIndex } from "./tasks-reports-model.js";

/** How far below the top of the reading area a place counts as being read: below the reader's
 *  sticky head (css: .tk-rep__head), with a little room. */
const OUTLINE_LINE = 110;

// the shown report's outline ({ heads, asks } from annotateReport, null without a report), the
// element that scrolls it, and the rows the panel shows now, in reading order
let shownOutline = null,
  outlineScroller = null,
  outlineRows = [];

/** The reader hands over the outline of the report it just built (null: no report on screen). */
export function setOutline(next, reader) {
  shownOutline = next;
  outlineScroller = reader;
  // a rebuilt reader (e.g. a resize across the narrow width, #1655) has new nodes for the same
  // places: the rows the panel shows follow them, so a click and the reading mark use the text on screen
  const now = new Map([...(next?.heads ?? []), ...(next?.asks ?? [])].map((e) => [e.index, e.el]));
  for (const r of outlineRows) r.el = now.get(r.index) ?? r.el;
}

/** Marks the row of the place being read (the reader's scroll event, a rebuilt panel). */
export function trackOutline() {
  if (!outlineScroller || !outlineRows.length) return;
  const top = outlineScroller.getBoundingClientRect().top,
    here = hereIndex(
      outlineRows.map((r) => r.el.getBoundingClientRect().top - top),
      OUTLINE_LINE
    );
  // the whole row is marked, and data-lsel puts the panel's active line on its outer right edge
  // (js/panel-indicator.js), as in every other list of the panel
  outlineRows.forEach((r, i) => {
    r.btn.classList.toggle("is-here", i === here);
    if (i === here) {
      r.btn.setAttribute("aria-current", "location");
      r.btn.setAttribute("data-lsel", "1");
    } else {
      r.btn.removeAttribute("aria-current");
      r.btn.removeAttribute("data-lsel");
    }
  });
}

/** One row: the square, the text (it wraps, never cut; Daniel 18.11.2026). */
function outlineRow(e, cls) {
  const row = { btn: null, el: e.el, index: e.index };
  row.btn = h(
    `button.tk-toc__j.${cls}`,
    {
      type: "button",
      title: e.text,
      on: {
        click: () => {
          row.el.scrollIntoView({ block: "start" });
          trackOutline();
        },
      },
    },
    h("span.tk-toc__sq", { "aria-hidden": "true" }),
    h("span.tk-toc__t", { text: e.text })
  );
  return row;
}

/** A block of the panel (css/panels.css: lens__sec, lens__list) under a small label with its count
 *  on the right (Daniel 18.11.2026, the draft's jump list: "REPORT", "QUESTIONS · 0 OF 7"). */
const outlineSection = (title, count, list, amber) =>
  h(
    "div.lens__sec.tk-toc",
    null,
    h(
      "div.tk-toc__h",
      null,
      h("span.tk-toc__h-t", { text: title }),
      count ? h("span.tk-toc__h-n", { cls: amber ? "is-amber" : "", text: count }) : null
    ),
    h(
      "nav.lens__list.tk-toc__list",
      { "aria-label": title },
      list.map((r) => r.btn)
    )
  );

function renderOutline(body) {
  outlineRows = [];
  if (!shownOutline) {
    body.append(h("div.lens__sec", null, h("p.tk-toc__none", { text: t("tk.rep.toc.pick") })));
    return;
  }
  const { heads, asks } = shownOutline;
  if (!heads.length && !asks.length) {
    body.append(h("div.lens__sec", null, h("p.tk-toc__none", { text: t("tk.rep.toc.none") })));
    return;
  }
  const headRows = heads.map((e) => outlineRow(e, "is-head")),
    askRows = asks.map((e) => outlineRow(e, e.answered ? "is-ask.is-done" : "is-ask")),
    answered = asks.filter((e) => e.answered).length;
  // the headings without a count, as in the draft; only the questions count what is left to do
  if (heads.length) body.append(outlineSection(t("tk.rep.toc.heads"), "", headRows, false));
  if (asks.length)
    body.append(
      outlineSection(
        t("tk.rep.toc.asks"),
        t("tk.rep.toc.answered", { n: answered, m: asks.length }),
        askRows,
        answered < asks.length
      )
    );
  outlineRows = [...headRows, ...askRows].sort((a, b) => a.index - b.index);
  trackOutline();
}

/** The panel tab the Tasks area shows while the reading view is open (js/lens.js renders it). */
export const outlineTab = { id: "toc", labelKey: "tk.rep.toc.tab", render: renderOutline };
