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
import { state } from "./state.js";
import { getArea } from "./areas.js";

let stage, current = null, unmount = null;

export function mountStage(app) {
  stage = h("main.stage");
  app.append(stage);
}

export function render(ctx) {
  if (current === state.view) return;
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
