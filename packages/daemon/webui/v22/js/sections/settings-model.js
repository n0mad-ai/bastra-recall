// Settings area — data side: daemon endpoints (the same ones the classic UI
// uses: /ui/settings/session, /ui/settings, /ui/settings/restart), the order
// of the groups, per-key presentation hints and the pending-change store.
//
// The rows come from the daemon's settings registry (GET /ui/settings), not
// from the prototype schema: only keys the daemon knows are shown. Keys the
// registry adds later land in the "more" group automatically.
import { state, setState } from "../state.js";

export const SETTINGS_FILE = "~/.bastra/cli-settings.json";

/** Groups in prototype order (settings-spec-v20.js SECTIONS), mapped onto real keys. */
export const GROUPS = [
  { id: "appearance", keys: ["ui.footer", "ui.timeline"] },
  { id: "general", keys: ["update.mode", "language.primary", "battery.saver", "ui.enabled", "assistant.name", "daemon.env"] },
  { id: "models", keys: ["embedding.provider", "ollama.autostart", "generation.model", "modelRecommendation.id", "modelRecommendation.answer", "modelRecommendation.at"] },
  { id: "recall", keys: ["reflex.enabled", "reflex.maxPerTurn", "evidenceGate.enabled", "experiment.name", "experiment.arms", "experiment.registration", "experiment.registration_version"] },
  { id: "sharing", keys: ["commons.enabled", "sharedRecall.enabled", "sharedRecall.language", "sharedRecall.live"] },
  { id: "code", keys: ["code.repos", "promptImpact.enabled", "coverageMap.enabled"] },
  { id: "writing", keys: ["docs.mode", "docs.language", "size.guide", "size.critical", "size.exemptPaths"] },
  { id: "archive", keys: ["archive.enabled", "archive.retain", "archive.cap", "archive.max-item"] },
  { id: "tasks", keys: ["tasks.enabled", "tasks.notifications", "tasks.chatActiveMinutes", "tasks.chatConsent"] },
  { id: "api", keys: ["api.token", "cors.origins"], oauth: true },
  { id: "logs", keys: ["telemetry.enabled"] },
  { id: "more", keys: [] },
];

/** Presentation hints the registry does not carry (bounds from the schema / prototype spec). */
export const META = {
  "reflex.maxPerTurn": { min: 1, max: 5, step: 1 },
  "size.guide": { min: 100, max: 5000, step: 50, unit: "lines" },
  "size.critical": { min: 100, max: 5000, step: 50, unit: "lines" },
  "tasks.chatActiveMinutes": { min: 1, max: 1440, step: 5, unit: "min" },
  "sharedRecall.live": { experimental: true },
  "promptImpact.enabled": { experimental: true },
  "coverageMap.enabled": { experimental: true },
  "experiment.name": { experimental: true },
  "experiment.arms": { experimental: true },
  "experiment.registration": { experimental: true },
  "experiment.registration_version": { experimental: true, min: 0, step: 1 },
};

/** UI settings of this browser (state.js › localStorage recall-v22-ui), applied at once. */
export const LOCAL = [
  { key: "ui.footer", kind: "string", choices: ["console", "mirror", "anchored", "drawer", "island"], stateKey: "footer" },
  { key: "ui.timeline", kind: "string", choices: ["bars", "pulse"], stateKey: "timeline" },
];

// ── store ────────────────────────────────────────────────────────────────
export const store = {
  model: null,          // GET /ui/settings snapshot
  error: "",            // load / save error text (server message)
  changes: new Map(),   // key → pending value (null = back to default)
  query: "",
  sel: "appearance",    // group shown as current in the Find tab
  saved: "",            // "HH:MM" of the last successful apply
  savedRestart: false,  // last apply touched restart-only keys
  busy: false,
  restarting: false,
};

const listeners = new Set();
export function onStore(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what = "all") { for (const fn of listeners) fn(what); }

let csrf = null;

async function call(path, body) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-Bastra-Settings-CSRF": csrf } : {}) },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401) csrf = null;
    throw Object.assign(new Error(json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`), { status: res.status });
  }
  return json;
}

async function session() {
  const s = await call("/ui/settings/session", {});
  if (!s || typeof s.csrf !== "string") throw new Error("no settings session");
  csrf = s.csrf;
}

/** Runs fn with a settings session; a lapsed session (401) is renewed once. */
async function withSession(fn) {
  if (!csrf) await session();
  try { return await fn(); } catch (err) {
    if (err.status !== 401) throw err;
    await session();
    return fn();
  }
}

function accept(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries)) throw new Error("invalid settings snapshot");
  store.model = { entries: snapshot.entries.filter((e) => e && typeof e.key === "string"),
    oauthClients: Array.isArray(snapshot.oauthClients) ? snapshot.oauthClients : [],
    restartAvailable: !!snapshot.restartAvailable };
}

export async function load() {
  store.error = "";
  try { accept(await withSession(() => call("/ui/settings"))); } catch (err) { store.error = err.message; }
  emit();
}

export async function apply() {
  if (!store.changes.size || store.busy) return;
  store.busy = true; store.error = ""; emit("bar");
  const restart = [...store.changes.keys()].some((k) => entry(k)?.restartRequired);
  try {
    accept(await withSession(() => call("/ui/settings", { changes: Object.fromEntries(store.changes) })));
    store.changes.clear();
    store.saved = new Date().toTimeString().slice(0, 5);
    store.savedRestart = restart;
  } catch (err) { store.error = err.message; }
  store.busy = false;
  emit();
}

export async function revokeOauth(clientId) {
  store.error = "";
  try { accept(await withSession(() => call("/ui/settings/oauth/revoke", { clientId }))); } catch (err) { store.error = err.message; }
  emit();
}

/** Controlled daemon restart (classic UI: "Daemon kontrolliert neu starten"), then reload. */
export async function restart() {
  if (store.restarting || store.changes.size) return;
  store.restarting = true; store.error = ""; emit("bar");
  try {
    await withSession(() => call("/ui/settings/restart", {}));
    csrf = null;
    // The daemon goes away and comes back; wait for health, then reload the snapshot.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try { const r = await fetch("/ui/health", { cache: "no-store" }); if (r.ok) break; } catch { /* still down */ }
    }
    store.savedRestart = false;
    store.restarting = false;
    await load();
  } catch (err) { store.restarting = false; store.error = err.message; emit(); }
}

// ── values ───────────────────────────────────────────────────────────────
export function entry(key) {
  const local = LOCAL.find((x) => x.key === key);
  if (local) return { ...local, local: true, value: state[local.stateKey], effective: state[local.stateKey], envOverride: [], isSet: true };
  return store.model?.entries.find((e) => e.key === key) || null;
}

/** Keys of a group that the daemon (or this browser) actually knows. */
export function groupKeys(g) {
  if (g.id === "appearance") return LOCAL.map((x) => x.key);
  if (!store.model) return [];
  const known = new Set(store.model.entries.map((e) => e.key));
  if (g.id !== "more") return g.keys.filter((k) => known.has(k));
  const mapped = new Set(GROUPS.flatMap((x) => x.keys));
  return store.model.entries.map((e) => e.key).filter((k) => !mapped.has(k));
}

export const locked = (e) => !!e && !e.local && (e.envOverride?.length > 0 || e.readonly || e.managed);
export const changed = (key) => store.changes.has(key);

/** Value the control shows: pending change, else stored value, else what is in effect. */
export function shown(e) {
  if (store.changes.has(e.key)) return store.changes.get(e.key);
  if (e.envOverride?.length) return e.effective;
  return e.value ?? e.effective ?? null;
}

export function setValue(key, value) {
  const e = entry(key);
  if (!e || locked(e)) return;
  if (e.local) { setState({ [e.stateKey]: value }); emit(); return; }
  const same = JSON.stringify(value) === JSON.stringify(e.value) && !(value === null && e.isSet);
  if (same) store.changes.delete(key); else store.changes.set(key, value);
  emit("value");
}

export function revert(key) { store.changes.delete(key); emit(); }
export function discard() { store.changes.clear(); emit(); }

export function changeList() {
  return [...store.changes.entries()].map(([key, value]) => ({ key, value, e: entry(key) })).filter((c) => c.e);
}

/** The CLI line a change stands for (bastra config set accepts every writable key). */
export function cliOf(e, v) {
  if (v === null) return null;
  const arg = typeof v === "boolean" ? String(v) : typeof v === "object" ? `'${JSON.stringify(v)}'` : /[\s'"]/.test(String(v)) ? `'${String(v).replaceAll("'", "'\\''")}'` : String(v);
  return `bastra config set ${e.key} ${e.secret ? "'…'" : arg}`;
}

/** Search text of a row: name, key, env names, chips. */
export function matches(e, name, desc, q) {
  if (!q) return true;
  const meta = META[e.key] || {};
  const text = [name, e.key, desc, ...(e.envOverride || []).map((x) => x.name),
    e.restartRequired ? "restart" : "", meta.experimental ? "experimental" : "", e.envOverride?.length ? "env" : "",
    e.secret ? "token secret" : "", e.local ? "ui local" : ""].join(" ").toLowerCase();
  return text.includes(q);
}

export { state };
