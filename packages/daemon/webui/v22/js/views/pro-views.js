// Free and Pro vault views (Daniel, 14.11.2026): Mindspace, Clouds and Semantic
// belong to free Recall; every view from Chronos on (Ring and the lenses) is
// Pro and locked until Pro is available. The daemon unlocks them for a preview
// install with BASTRA_PRO_PREVIEW (GET /ui/health › pro_preview).
// Pickers: right panel › View (lens.js); the rail's Vault button opens the
// last chosen view (nav.js); stage.js keeps a locked view off the stage.
import { t } from "../i18n.js";
import { setState } from "../state.js";
import { data } from "../data.js";
import { VAULT_VIEWS } from "../areas.js";

export const FREE_VIEWS = ["mindspace", "clouds", "semantic"];
export const isPro = (v) => VAULT_VIEWS.includes(v) && !FREE_VIEWS.includes(v);

/** true / false once /ui/health answered, null before. */
export function proOpen() { const hl = data.health; return hl && typeof hl === "object" ? hl.pro_preview === true : null; }
export const viewLocked = (v) => isPro(v) && proOpen() !== true;

const KEY = "recall-v22-vault-view";
/** The vault view the Vault button opens: the last one chosen, if it may be opened. */
export function lastVaultView() {
  let v = null;
  try { v = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  return VAULT_VIEWS.includes(v) && !viewLocked(v) ? v : FREE_VIEWS[0];
}
export function rememberVaultView(v) {
  if (!VAULT_VIEWS.includes(v) || viewLocked(v)) return;
  try { localStorage.setItem(KEY, v); } catch { /* storage blocked */ }
}

/** Open a vault view; a locked Pro view shows the Pro hint in the ticker instead. */
export function pickVaultView(v) {
  if (viewLocked(v)) { setState({ toast: t("vv.proHint") }); return false; }
  setState({ view: v, hover: null });
  return true;
}
