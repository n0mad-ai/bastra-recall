// Vault views registered as areas. Group "vault-view" is not in GROUPS, so
// the rail adds no buttons; the views are picked in the right panel › View
// (js/lens.js; Free and Pro: pro-views.js).
// Mindspace, Clouds and Semantic run the old map engines unchanged
// (engine-host.js) inside the v22 frame (engine-view.js).
import { registerArea, ICON } from "../areas.js";
import { mountRing } from "./ring.js";
import { mountLensView } from "./lens-view.js";
import { mountEngineView, viewTab } from "./engine-view.js";

registerArea({ id: "ring", group: "vault-view", order: 1, labelKey: "view.ring", icon: ICON.ring, mount: (stage) => mountRing(stage) });
["chronos", "radiant", "spiral", "halflife", "weave"].forEach((id, i) =>
  registerArea({ id, group: "vault-view", order: 2 + i, labelKey: `view.${id}`, icon: ICON[id], mount: (stage) => mountLensView(id, stage) }));
[["mindspace", 0], ["clouds", 0.5], ["semantic", 1.5]].forEach(([id, order]) =>
  registerArea({ id, group: "vault-view", order, labelKey: `view.${id}`, icon: ICON[id], viewTab: viewTab(id), signalFilter: true, mount: (stage) => mountEngineView(id, stage) }));
