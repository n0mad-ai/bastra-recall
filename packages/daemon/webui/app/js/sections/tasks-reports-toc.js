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
}

/** Marks the row of the place being read (the reader's scroll event, a rebuilt panel). */
export function trackOutline() {
  if (!outlineScroller || !outlineRows.length) return;
  const top = outlineScroller.getBoundingClientRect().top,
    here = hereIndex(
      outlineRows.map((r) => r.el.getBoundingClientRect().top - top),
      OUTLINE_LINE
    );
  outlineRows.forEach((r, i) => {
    r.btn.classList.toggle("is-here", i === here);
    if (i === here) r.btn.setAttribute("aria-current", "location");
    else r.btn.removeAttribute("aria-current");
  });
}

/** One row: the square, the text (two lines at most, the full text on hover). */
function outlineRow(e, cls) {
  const btn = h(
    `button.tk-toc__j.${cls}`,
    {
      type: "button",
      title: e.text,
      on: {
        click: () => {
          e.el.scrollIntoView({ block: "start" });
          trackOutline();
        },
      },
    },
    h("span.tk-toc__sq", { "aria-hidden": "true" }),
    h("span.tk-toc__t", { text: e.text })
  );
  return { btn, el: e.el, index: e.index };
}

/** A block of the panel in the panel's own section style (css/panels.css: lens__sec, lens__h). */
const outlineSection = (title, count, list, amber) =>
  h(
    "div.lens__sec.tk-toc",
    null,
    h(
      "div.lens__h",
      null,
      h("span.lens__h-t", { text: title }),
      h("span.lens__h-n", { cls: amber ? "is-amber" : "", text: count })
    ),
    h(
      "nav.tk-toc__list",
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
  if (heads.length) body.append(outlineSection(t("tk.rep.toc.heads"), String(heads.length), headRows, false));
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
