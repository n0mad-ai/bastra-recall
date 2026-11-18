// Task reports — the text size of the report (Daniel 18.11.2026: "next to read and delete … the
// enlargement"): three steps in the reader's head, small = the size the reader had before, medium
// (the default) noticeably larger and airier, large for reading at a distance. It changes the report
// text only, never the notes or the rest of the page, and this browser keeps the choice.
import { h } from "../dom.js";
import { t } from "../i18n.js";

const SIZE_KEY = "recall-reports-text-size";
const SIZES = ["s", "m", "l"];
const SIZE_DEFAULT = "m";

/** The stored step; storage may be blocked (private window, policy), then the default. */
function loadSize() {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return SIZES.includes(v) ? v : SIZE_DEFAULT;
  } catch {
    return SIZE_DEFAULT;
  }
}

let currentSize = loadSize();

/** "s", "m" or "l": the class suffix of the report text (css/tasks-reports.css: is-size-…). */
export const textSize = () => currentSize;

function pickSize(next, onChange) {
  if (next === currentSize) return;
  currentSize = next;
  try {
    localStorage.setItem(SIZE_KEY, next);
  } catch {
    // not kept in this browser; the choice still holds until the page reloads
  }
  onChange();
}

/** Three "A" buttons growing in size, one pressed; each is a plain button, so Tab and Enter or
 *  Space reach and press them, and its label names the step for a screen reader. */
export function sizeSwitch(onChange) {
  return h(
    "div.tk-rep__size",
    { role: "group", "aria-label": t("tk.rep.size.label") },
    SIZES.map((s) =>
      h(`button.tk-rep__sz.is-${s}`, {
        type: "button",
        text: "A",
        title: t(`tk.rep.size.${s}`),
        "aria-label": t(`tk.rep.size.${s}`),
        "aria-pressed": String(s === currentSize),
        cls: s === currentSize ? "is-on" : "",
        on: { click: () => pickSize(s, onChange) },
      })
    )
  );
}
