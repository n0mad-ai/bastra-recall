// Content area. Areas mount here; until an area is built in the new design it
// shows the "In progress" marker (README › Platzhalter).
//
// Normal areas (registerArea({ section })) get a stage frame and mount into
// its content element: .sx (stage) › [.sx__scroll] › .sx__in (content).
//   frame: true  → inner content frame (border, dark glass), padding 18px 28px
//   frame: false → no frame; the scrollbar sits outside the content edge
//   fit:   true  → no scrolling, .sx__in is a column that fills the height
// Vault views register without `section` and get the bare stage.
import { h, clear } from "./dom.js";
import { t } from "./i18n.js";
import { state, setState } from "./state.js";
import { getArea, VAULT_VIEWS } from "./areas.js";
import { closeMemoryBrowser } from "./views/memory-browser.js";
import { viewLocked, proOpen, lastVaultView } from "./views/pro-views.js";

let stage, current = null, unmount = null, closing = false;

export function mountStage(app) {
  stage = h("main.stage");
  app.append(stage);
}

export function render(ctx) {
  // Reopening the browser cancels a pending departure by restoring its host
  // view. Its show() cancels the shrink timeout, so clear our guard here too.
  if (current === state.view) { closing = false; return; }
  if (closing) return;
  // A locked Pro view (views/pro-views.js) never reaches the stage, whatever
  // route asked for it: before /ui/health answers nothing mounts yet, then it
  // falls back to a free view (with the Pro hint unless at start-up).
  if (viewLocked(state.view)) {
    if (proOpen() === null) return;
    const toast = current === null ? state.toast : t("vv.proHint");
    queueMicrotask(() => setState({ view: lastVaultView(), toast }));
    return;
  }
  // Leaving the vault views with the memory browser open: the browser shrinks
  // away first, then the area changes (every route: rail, header, links). It
  // stays open between vault views (memory-browser.js).
  if (VAULT_VIEWS.includes(current) && !VAULT_VIEWS.includes(state.view)) {
    // cover(false) can synchronously reenter render through the state store.
    // Guard before calling hide, not after, to avoid scheduling it twice.
    closing = true;
    if (closeMemoryBrowser(() => { closing = false; render(ctx); })) return;
    closing = false;
  }
  current = state.view;
  if (typeof unmount === "function") unmount();
  unmount = null;
  clear(stage);
  const area = getArea(state.view);
  if (area && typeof area.mount === "function") { unmount = area.mount(area.section ? sectionFrame(area.section) : stage, ctx) || null; return; }
  stage.append(h("div.stage__wip", null, h("div.stage__wip-in", null,
    h("span.wip-badge", { text: t("wip") }),
    h("span.stage__wip-t", { text: ctx.viewLabel(state.view) }),
    h("p.stage__wip-p", { text: t("wip.stage") }))));
}

function sectionFrame({ frame = false, fit = false }) {
  const inner = h("div.sx__in");
  stage.append(h("section.sx", { cls: [frame ? "sx--frame" : "", fit ? "sx--fit" : ""].join(" ") },
    fit ? inner : h("div.sx__scroll", null, inner)));
  return inner;
}
