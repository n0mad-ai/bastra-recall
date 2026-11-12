// Background image behind every view (settings ui.backdrop / ui.backdropDim /
// ui.backdropBlur; prototype "backdrop" layer). Sits between the glow and the
// frame, inset 12px = inside the frame, under all content. Stored by the daemon
// (GET /ui/backdrop at boot), so it holds per machine, CLI included.
// The settings page previews through setBackdrop() and saves via settings-model.js.
import { addStrings } from "./i18n.js";
import { h, setVars } from "./dom.js";
import en from "./i18n/backdrop-en.js";
import de from "./i18n/backdrop-de.js";

addStrings(en, de);

/** Prototype BD_PRESETS (ids = daemon registry BACKDROP_PRESETS); the looks live in css/backdrop.css. */
export const PRESETS = ["none", "aurora", "deepsea", "ember", "topo", "grid", "dusk"];
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const UPLOAD_MAX = 8 * 1024 * 1024;

export const backdrop = { cfg: { backdrop: "none", dim: 80, blur: false }, uploads: [] };

const listeners = new Set();
export function onBackdrop(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => { for (const fn of listeners) fn(); };

let layer = null, img = null, shownId = "";

export function mountBackdrop(app) {
  img = h("div.bd__img");
  img.addEventListener("animationend", () => img.classList.remove("is-in"));
  layer = h("div.bd", { hidden: true, "aria-hidden": "true" }, img, h("div.bd__shade"), h("div.bd__vig"));
  const glow = app.querySelector(".glow");
  if (glow) glow.after(layer); else app.prepend(layer);
  render();
  load();
}

/** CSS class + custom properties of an option (also used by the picker tiles). */
export function lookOf(id) {
  if (PRESETS.includes(id)) return { cls: `bd-p--${id}`, vars: null };
  const up = backdrop.uploads.find((u) => u.id === id);
  return up ? { cls: "bd-p--upload", vars: { "--bd-url": `url("${up.url}")` } } : null;
}

function render() {
  if (!layer) return;
  const { backdrop: id, dim, blur } = backdrop.cfg;
  const look = id === "none" ? null : lookOf(id);
  layer.hidden = !look;
  if (!look) { shownId = ""; return; }
  if (id !== shownId) {
    img.className = `bd__img ${look.cls}`;
    img.style.removeProperty("--bd-url");
    if (look.vars) setVars(img, look.vars);
    // Fade in once per image; the class goes again on animationend (no lasting layer).
    void img.offsetWidth; img.classList.add("is-in");
    shownId = id;
  }
  setVars(layer, { "--bd-dim": (Math.min(95, Math.max(50, Number(dim) || 80)) / 100).toFixed(2) });
  layer.classList.toggle("is-blur", !!blur);
}

export async function load() {
  try {
    const r = await fetch("/ui/backdrop", { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || typeof j !== "object") return;
    backdrop.uploads = Array.isArray(j.uploads) ? j.uploads.filter((u) => u && typeof u.id === "string" && typeof u.url === "string" && u.url.startsWith("/ui/backdrop/")) : [];
    backdrop.cfg = { backdrop: typeof j.backdrop === "string" ? j.backdrop : "none", dim: Number.isFinite(j.dim) ? j.dim : 80, blur: j.blur === true };
    render(); emit();
  } catch { /* daemon away: no image */ }
}

/** Preview / apply at once (patch of { backdrop, dim, blur }). */
export function setBackdrop(patch) { backdrop.cfg = { ...backdrop.cfg, ...patch }; render(); emit(); }

/** Stores an image on this machine; resolves with its id. Errors carry code type | size | count | fail. */
export async function uploadBackdrop(file) {
  const fail = (code, err = "") => Object.assign(new Error(err || code), { code });
  if (!UPLOAD_TYPES.includes(file.type)) throw fail("type");
  if (file.size > UPLOAD_MAX) throw fail("size");
  let r;
  try {
    r = await fetch(`/ui/backdrop?name=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type }, body: file });
  } catch (err) { throw fail("fail", err.message); }
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (r.status === 413) throw fail("size");
  if (r.status === 415) throw fail("type");
  if (r.status === 409) throw fail("count");
  if (!r.ok || !j || typeof j.id !== "string") throw fail("fail", j && typeof j.error === "string" ? j.error : `HTTP ${r.status}`);
  backdrop.uploads = [...backdrop.uploads, { id: j.id, name: String(j.name || ""), url: j.url }];
  emit();
  return j.id;
}

/** Removes an upload from this machine; the daemon resets ui.backdrop when it was the active image. */
export async function removeBackdrop(id) {
  const r = await fetch(`/ui/backdrop/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error(j && typeof j.error === "string" ? j.error : `HTTP ${r.status}`);
  backdrop.uploads = backdrop.uploads.filter((u) => u.id !== id);
  if (backdrop.cfg.backdrop === id) backdrop.cfg = { ...backdrop.cfg, backdrop: "none" };
  render(); emit();
}
