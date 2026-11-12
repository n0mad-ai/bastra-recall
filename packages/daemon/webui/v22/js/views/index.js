// Vault views registered as areas. Group "vault-view" is not in GROUPS, so
// the rail adds no buttons; the views are picked from the vault pop-over.
// Mindspace, Clouds and Semantic are not registered here (engines stay as
// they are and are docked separately).
import { registerArea, ICON } from "../areas.js";
import { mountRing } from "./ring.js";
import { mountLensView } from "./lens-view.js";

registerArea({ id: "ring", group: "vault-view", order: 1, labelKey: "view.ring", icon: ICON.ring, mount: (stage) => mountRing(stage) });
["chronos", "radiant", "spiral", "halflife", "weave"].forEach((id, i) =>
  registerArea({ id, group: "vault-view", order: 2 + i, labelKey: `view.${id}`, icon: ICON[id], mount: (stage) => mountLensView(id, stage) }));
