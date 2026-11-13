// Layers that cover the stage (memory browser, modal dialogs) freeze the vault
// view beneath them (Daniel 13.11.2026: "Hinter dem Milchglas muss sich nichts
// bewegen"); closing them lets everything run on. Side panels do not count.
// Views read state.covered (engine-view.js → engine.freeze, ring.js → face).
import { setState } from "./state.js";

const by = new Set();

/** key: who covers ("mb", "dlg"); on: whether it covers the stage now. */
export function cover(key, on) {
  if (on) by.add(key); else by.delete(key);
  setState({ covered: by.size > 0 });
}
