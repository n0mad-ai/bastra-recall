// Run indicators (Daniel's rule: every asynchronous start shows that it runs,
// where the user looks — at the element they touched, not only in a corner).
// Motion is the prototype's: tick-scan sweep (buttons, chips), tkr-scan band
// (content being replaced), tree-flow line and caret (placeholders, notes).
// CSS: css/sections.css › run indicators. CSS animations only, and only while
// something runs.
//
//   setBusy(button, true)        sweep on the element, aria-busy, no double click
//   veil(frame, true)            old content dimmed, scan band runs over it
//   loadingBlock(text)           placeholder while there is nothing to show yet
//   loadingInline(text)          one line with flow and caret (widgets, notes)
import { h } from "../dom.js";
import { addStrings, t } from "../i18n.js";
import { state, subscribe } from "../state.js";
import { data, onData } from "../data.js";
import { VAULT_VIEWS } from "../areas.js";
import en from "../i18n/loading-en.js";
import de from "../i18n/loading-de.js";

addStrings(en, de);

/** Sweep on a control while its action runs. */
export function setBusy(el, on) {
  if (!el || !el.classList) return;
  el.classList.toggle("ld-on", !!on);
  if (on) el.setAttribute("aria-busy", "true");
  else el.removeAttribute("aria-busy");
}

/** Dims the content of a container and runs the scan band over it. */
export function veil(el, on) {
  if (!el || !el.classList) return;
  el.classList.toggle("ld-veil", !!on);
  if (on) el.setAttribute("aria-busy", "true");
  else el.removeAttribute("aria-busy");
}

/** HUD-style placeholder: corner marks, label with caret, flowing line, skeleton rows. */
export function loadingBlock(text, { rows = 3, cls = "" } = {}) {
  return h(
    "div.ld-block",
    { cls, role: "status", "aria-live": "polite" },
    h("span.ld-block__corners"),
    h("div.ld-block__t", null, h("span", { text }), h("span.ld-caret")),
    h("span.ld-flow"),
    Array.from({ length: rows }, (_, i) => h("span.ld-sk", { cls: `ld-sk--${i % 3}` }))
  );
}

/** One-line indicator for small places (widgets, dialog status, panel notes). */
export function loadingInline(text, cls = "") {
  return h(
    "span.ld-inline",
    { cls, role: "status" },
    h("span.ld-inline__dot"),
    h("span", { text }),
    h("span.ld-caret")
  );
}

/** The control that started an action: the focused button/link/input inside the app. */
export function touched() {
  const el = document.activeElement;
  return el &&
    el !== document.body &&
    el.closest?.("#app") &&
    el.matches?.("button, a, [role=button], input, select, li")
    ? el
    : null;
}

// Vault views before the first graph answer: one placeholder over the stage,
// without touching the view modules. Runs after the shell's render (rAF),
// because a view change clears the stage.
let stageNode = null,
  stageRaf = 0;
function checkStage() {
  if (stageRaf) return;
  stageRaf = requestAnimationFrame(() => {
    stageRaf = 0;
    const stage = document.querySelector("main.stage");
    const need = !!stage && VAULT_VIEWS.includes(state.view) && !data.graph;
    if (!need) {
      stageNode?.remove();
      stageNode = null;
      return;
    }
    const err = !!data.graphError;
    if (stageNode && stage.contains(stageNode) && stageNode.dataset.err === String(err)) return;
    stageNode?.remove();
    stageNode = h(
      "div.ld-stage",
      { "data-err": String(err) },
      loadingBlock(t(err ? "ld.vaultErr" : "ld.vault"), { cls: err ? "is-err" : "" })
    );
    stage.append(stageNode);
  });
}
subscribe(checkStage);
onData(checkStage);
checkStage();
