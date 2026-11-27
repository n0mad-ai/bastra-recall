// Settings area — data side: daemon endpoints (the same ones the classic UI
// uses: /ui/settings/session, /ui/settings, /ui/settings/restart), the order
// of the groups, per-key presentation hints and the pending-change store.
//
// The rows come from the daemon's settings registry (GET /ui/settings), not
// from the prototype schema: only keys the daemon knows are shown. Keys the
// registry adds later land in the "more" group automatically.
import { state, setState } from "../state.js";
import { t } from "../i18n.js";
import { setBackdrop } from "../backdrop.js";
import { jsonRequest, settingsSession } from "../session-client.js";

/** t() with a fallback when the key is missing (server label for unknown keys). */
export function tx(key, fallback, vars) {
  const s = t(key, vars);
  return s === key ? fallback : s;
}
export const nameOf = (e) => tx(`st.k.${e.key}`, e.label || e.key);
export const descOf = (e) => tx(`st.k.${e.key}.d`, "");
export const groupTitle = (g) => t(`st.g.${g.id}`);

/** Display text of a value (Changes: old → new). */
export function fmt(e, v) {
  if (v === null || v === undefined) return t("st.v.default");
  if (e.secret) return "••••••••";
  if (typeof v === "boolean") return t(v ? "st.v.on" : "st.v.off");
  if (Array.isArray(v)) return v.length ? v.join(", ") : t("st.v.none");
  if (typeof v === "object") return JSON.stringify(v);
  return v === "" ? "—" : String(v);
}

export const SETTINGS_FILE = "~/.bastra/cli-settings.json";

/** Groups in prototype order (settings-spec-v20.js SECTIONS), mapped onto real keys. */
export const GROUPS = [
  { id: "appearance", keys: ["ui.footer", "ui.timeline", "ui.backdrop", "ui.backdropDim", "ui.backdropBlur"] },
  {
    id: "general",
    keys: [
      "update.mode",
      "language.primary",
      "autostart",
      "battery.saver",
      "vault.reconcile",
      "ui.enabled",
      "daemon.env",
    ],
  },
  // Shown as "Agent and personality": the agent's own settings join here.
  { id: "personality", keys: ["assistant.name", "soul.direction", "soul.text"] },
  {
    id: "models",
    keys: [
      "embedding.provider",
      "embedding.model",
      "ollama.autostart",
      "ollama.url",
      "generation.model",
      "ollama.keepAlive",
      "modelRecommendation.id",
      "modelRecommendation.answer",
      "modelRecommendation.at",
    ],
  },
  {
    id: "recall",
    keys: [
      "recall.floor",
      "reflex.enabled",
      "reflex.maxPerTurn",
      "prompt.hookMode",
      "hint.suppress",
      "hint.suppressAfter",
      "evidenceGate.enabled",
      "scope.filterLanes",
      "experiment.name",
      "experiment.arms",
      "experiment.registration",
      "experiment.registration_version",
    ],
  },
  { id: "sharing", keys: ["commons.enabled", "sharedRecall.enabled", "sharedRecall.language", "sharedRecall.live"] },
  { id: "code", keys: ["code.repos", "promptImpact.enabled", "coverageMap.enabled"] },
  {
    id: "writing",
    keys: [
      "docs.mode",
      "docs.language",
      "size.guide",
      "size.critical",
      "size.exemptPaths",
      "saveNotice",
      "redaction.enabled",
    ],
  },
  { id: "archive", keys: ["archive.enabled", "archive.retain", "archive.cap", "archive.max-item"] },
  {
    id: "tasks",
    keys: ["tasks.enabled", "tasks.notifications", "tasks.chatActiveMinutes", "tasks.reportUndo", "tasks.chatConsent"],
  },
  { id: "api", keys: ["api.token", "cors.origins"], oauth: true },
  { id: "logs", keys: ["telemetry.enabled", "logs.retention", "logs.path", "training.capture"] },
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
  "hint.suppressAfter": { unit: "surfaces" },
  "logs.retention": { unit: "days" },
  "ui.backdropDim": { min: 50, max: 95, step: 5, unit: "%" },
};

/** Pick lists for free-form keys: typical values (std = the registry default, marked automatically),
 *  `custom` adds "Custom value …", `pre` shares one label set (st.o.<pre>.<value>), `k` overrides the label key,
 *  `models` merges the Ollama models installed on this machine (GET /ui/settings/models). */
const LANGS = ["de", "en", "fr", "es", "it", "nl", "pt"].map((v) => ({ v }));
const nums = (...a) => a.map((v) => ({ v }));
export const OPTIONS = {
  "language.primary": { vals: LANGS, pre: "lang", custom: true },
  "docs.language": { vals: LANGS, pre: "lang", custom: true },
  "sharedRecall.language": { vals: [{ v: null }, { v: "de" }, { v: "en" }], pre: "lang" },
  "generation.model": { vals: nums("gemma3:1b", "gemma3:4b", "gemma3:12b"), models: true, custom: true },
  "embedding.model": { vals: nums("embeddinggemma"), models: true, custom: true },
  "ollama.url": { vals: nums("http://localhost:11434"), custom: true },
  "ollama.keepAlive": { vals: nums("0", "5m", "10m", "30m", "1h", "24h"), custom: true },
  "archive.retain": {
    vals: [
      "junk=1,in-git=1,user=1",
      "junk=1,in-git=2,user=2",
      "junk=3,in-git=7,user=7",
      "junk=7,in-git=14,user=30",
    ].map((v, i) => ({ v, k: `r${i}` })),
    custom: true,
  },
  "archive.cap": { vals: nums("1GB", "5GB", "10GB", "25GB", "50GB"), custom: true },
  "archive.max-item": { vals: nums(null, "100MB", "500MB", "1GB", "2GB", "5GB"), custom: true },
  "size.guide": { vals: nums(200, 300, 500, 800, 1000), custom: true },
  "size.critical": { vals: nums(500, 800, 1000, 1500, 2000), custom: true },
  "tasks.chatActiveMinutes": { vals: nums(10, 15, 30, 60, 120, 240), custom: true },
  "tasks.reportUndo": { vals: nums("off", "10m", "1h", "1d", "7d", "30d"), custom: true },
  "recall.floor": { vals: nums(10, 20, 30, 40, 50, 60), custom: true },
  "hint.suppressAfter": { vals: nums(3, 5, 8, 12, 20), custom: true },
  "reflex.maxPerTurn": { vals: nums(1, 2, 3, 4, 5) },
  "logs.retention": { vals: nums(30, 60, 90, 180, 365), custom: true },
};

/** Runtime metadata takes precedence over presentation hints. */
export const metaOf = (e) => ({
  ...(META[e.key] || {}),
  ...Object.fromEntries(
    ["min", "max", "step", "unit", "experimental"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]])
  ),
});

/** UI settings of this browser (state.js › localStorage recall-v22-ui), applied at once. */
export const LOCAL = [
  {
    key: "ui.footer",
    kind: "string",
    choices: ["console", "mirror", "anchored", "drawer", "island"],
    stateKey: "footer",
  },
  { key: "ui.timeline", kind: "string", choices: ["bars", "pulse"], stateKey: "timeline" },
];

// ── store ────────────────────────────────────────────────────────────────
export const store = {
  model: null, // GET /ui/settings snapshot
  error: "", // load / save error text (server message)
  changes: new Map(), // key → pending value (null = back to default)
  invalid: new Map(), // key → raw text of a draft that is not valid (JSON, custom number); blocks Apply and restart
  query: "",
  sel: "appearance", // group shown as current in the Find tab
  saved: "", // "HH:MM" of the last successful apply
  savedRestart: false, // last apply touched restart-only keys
  busy: false,
  restarting: false,
  models: [], // installed Ollama models (empty when Ollama is not reachable)
  address: null, // GET /ui/assistant-address status of the assistant's local address
};

const listeners = new Set();
export function onStore(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(what = "all") {
  for (const fn of listeners) fn(what);
}

function settingsJson(res, json) {
  if (!res.ok)
    throw Object.assign(new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`), {
      status: res.status,
      code: typeof json?.code === "string" ? json.code : undefined,
    });
  return json;
}

function settingsCsrf({ response, body }) {
  const session = settingsJson(response, body);
  if (typeof session?.csrf !== "string") throw new Error("no settings session");
  return session.csrf;
}

async function requestSettings(path, body, csrf) {
  const res = await jsonRequest(path, body, csrf ? { "X-Bastra-Settings-CSRF": csrf } : undefined);
  const json = await res.json().catch(() => null);
  return { res, json };
}

/** The assistant-address route does not open a settings session. */
async function call(path, body) {
  const grant = settingsSession.current();
  const { res, json } = await requestSettings(path, body, grant?.body.csrf);
  if (res.status === 401) settingsSession.invalidate(grant);
  return settingsJson(res, json);
}

function settingsApi(path, body) {
  return settingsSession.run(settingsCsrf, async (csrf, { renew, invalidate }) => {
    const { res, json } = await requestSettings(path, body, csrf);
    // 403 csrf_mismatch: another tab replaced the session cookie (#1699). Origin/host 403s carry no code.
    if (res.status === 401 || (res.status === 403 && json?.code === "csrf_mismatch")) {
      if (renew) return renew();
      invalidate();
    }
    return settingsJson(res, json);
  });
}

function accept(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries)) throw new Error("invalid settings snapshot");
  store.model = {
    entries: snapshot.entries.filter((e) => e && typeof e.key === "string"),
    oauthClients: Array.isArray(snapshot.oauthClients) ? snapshot.oauthClients : [],
    restartAvailable: !!snapshot.restartAvailable,
  };
}

export async function load() {
  store.error = "";
  try {
    accept(await settingsApi("/ui/settings"));
  } catch (err) {
    store.error = err.message;
  }
  emit();
  void loadAddress();
}

/** Address status for the name row; without it the row just shows no address note. */
async function loadAddress() {
  try {
    store.address = await call("/ui/assistant-address");
  } catch {
    store.address = null;
  }
  emit("value");
}

const NAME = "assistant.name";
/** The name has its own endpoint: saving it is the user's instruction to set up the matching
 *  address too (macOS asks once for an administrator password). The display name applies even
 *  when that part fails; store.address then carries the reason. */
async function saveName(name) {
  if (typeof name !== "string" || !name.trim()) throw Object.assign(new Error(""), { code: "invalid_name" });
  store.address = await call("/ui/assistant-address", { name, systemConsent: true });
  accept(await settingsApi("/ui/settings"));
}

/** Address step again for the saved name (button in the name row). */
export async function retryAddress() {
  if (store.busy) return;
  store.busy = true;
  store.error = "";
  emit("bar");
  try {
    await saveName(entry(NAME)?.value);
  } catch (err) {
    store.error = errorText(err);
  }
  store.busy = false;
  emit();
}

const errorText = (err) => (err.code === "invalid_name" ? t("st.addr.invalid") : err.message);

function saveBatch(batch) {
  if (batch[0][0] === NAME) return saveName(batch[0][1]);
  return settingsApi("/ui/settings", { changes: Object.fromEntries(batch) }).then(accept);
}

/** Installed Ollama models for the model pickers; a failure just leaves the static suggestions. */
export async function loadModels() {
  try {
    const r = await settingsApi("/ui/settings/models");
    const models = Array.isArray(r?.models)
      ? r.models.filter((m) => typeof m === "string").map((m) => m.replace(/:latest$/, ""))
      : [];
    if (JSON.stringify(models) !== JSON.stringify(store.models)) {
      store.models = models;
      emit();
    }
  } catch {
    /* suggestions only */
  }
}

/** Text for an invalid draft: JSON fields say JSON, other fields (custom number) say value. */
export const invalidText = (key, short = false) =>
  t(`st.${entry(key)?.kind === "json" ? "json" : "value"}.invalid${short ? "Short" : ""}`);

/** An invalid draft blocks Apply and restart: the error names it and the view focuses its field. */
function blockedByInvalid() {
  if (!store.invalid.size) return false;
  store.error = invalidText([...store.invalid.keys()][0]);
  emit("invalid");
  return true;
}

export async function apply() {
  if (store.busy || blockedByInvalid() || !store.changes.size) return;
  store.busy = true;
  store.error = "";
  emit("bar");
  // Login-service registration and the name/address are separate OS writes, outside the settings DB.
  const pending = [...store.changes.entries()];
  const own = (k) => k === "autostart" || k === NAME;
  const batches = [pending.filter(([k]) => !own(k)), ...pending.filter(([k]) => own(k)).map((c) => [c])];
  try {
    for (const batch of batches.filter((b) => b.length)) {
      const restart = batch.some(([k]) => entry(k)?.restartRequired);
      await saveBatch(batch);
      for (const [key, value] of batch) {
        if (JSON.stringify(store.changes.get(key)) === JSON.stringify(value)) store.changes.delete(key);
      }
      store.saved = new Date().toTimeString().slice(0, 5);
      store.savedRestart ||= restart;
    }
  } catch (err) {
    store.error = errorText(err);
  }
  store.busy = false;
  if (!store.error) setState({ toast: { text: t("st.savedNote") } });
  emit();
}

export async function revokeOauth(clientId) {
  store.error = "";
  try {
    accept(await settingsApi("/ui/settings/oauth/revoke", { clientId }));
  } catch (err) {
    store.error = err.message;
  }
  emit();
}

/** Controlled daemon restart (classic UI: "Daemon kontrolliert neu starten"), then reload. */
export async function restart() {
  if (store.restarting || blockedByInvalid() || store.changes.size) return;
  store.restarting = true;
  store.error = "";
  emit("bar");
  try {
    await settingsApi("/ui/settings/restart", {});
    settingsSession.invalidate(settingsSession.current());
    // The daemon goes away and comes back; wait for health, then reload the snapshot.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await fetch("/ui/health", { cache: "no-store" });
        if (r.ok) break;
      } catch {
        /* still down */
      }
    }
    store.savedRestart = false;
    store.restarting = false;
    await load();
  } catch (err) {
    store.restarting = false;
    store.error = err.message;
    emit();
  }
}

// ── values ───────────────────────────────────────────────────────────────
export function entry(key) {
  const local = LOCAL.find((x) => x.key === key);
  if (local)
    return {
      ...local,
      local: true,
      value: state[local.stateKey],
      effective: state[local.stateKey],
      envOverride: [],
      isSet: true,
    };
  return store.model?.entries.find((e) => e.key === key) || null;
}

/** The assistant name the user has set, or null while none is set (the shown default is then the product name). */
export function assistantName() {
  const e = store.model?.entries.find((x) => x.key === "assistant.name");
  return e?.isSet && typeof e.value === "string" && e.value.trim() ? e.value.trim() : null;
}

/** Keys of a group that the daemon (or this browser) actually knows. */
export function groupKeys(g) {
  const known = new Set(store.model?.entries.map((e) => e.key) || []);
  if (g.id === "appearance") return [...LOCAL.map((x) => x.key), ...g.keys.filter((k) => known.has(k))];
  if (!store.model) return [];
  if (g.id !== "more") return g.keys.filter((k) => known.has(k));
  const mapped = new Set(GROUPS.flatMap((x) => x.keys));
  return store.model.entries.map((e) => e.key).filter((k) => !mapped.has(k));
}

export const locked = (e) => !!e && !e.local && (e.envOverride?.length > 0 || e.readonly);
export const changed = (key) => store.changes.has(key) || store.invalid.has(key);
export const pendingKeys = () => [...new Set([...store.changes.keys(), ...store.invalid.keys()])];

/** Value the control shows: pending change, else stored value, else what is in effect. */
export function shown(e) {
  if (e.local) return state[e.stateKey];
  if (store.changes.has(e.key)) return store.changes.get(e.key);
  if (e.envOverride?.length) return e.effective;
  return e.value ?? e.effective ?? null;
}

export function setValue(key, value) {
  const e = entry(key);
  if (!e || locked(e)) return;
  if (e.local) {
    setState({ [e.stateKey]: value });
    emit("value");
    return;
  }
  const same = JSON.stringify(value) === JSON.stringify(e.value) && !(value === null && e.isSet);
  if (same) store.changes.delete(key);
  else store.changes.set(key, value);
  emit("value");
}

/** The background image previews the shown (pending) values at once; Apply stores them (prototype bdCfg = stCfg). */
const BACKDROP = { "ui.backdrop": "backdrop", "ui.backdropDim": "dim", "ui.backdropBlur": "blur" };
onStore(() => {
  if (!store.model) return;
  const patch = {};
  for (const [key, field] of Object.entries(BACKDROP)) {
    const e = entry(key);
    if (e) patch[field] = shown(e) ?? e.default;
  }
  setBackdrop(patch);
});

/** Records (raw text) or clears (null) a draft that is not valid (JSON, custom number). */
export function setInvalid(key, raw) {
  if (raw !== null) {
    store.invalid.set(key, raw);
    return;
  }
  if (store.invalid.delete(key)) clearInvalidError();
}

function clearInvalidError() {
  const texts = [t("st.json.invalid"), t("st.value.invalid")];
  if (!store.invalid.size && texts.includes(store.error)) store.error = "";
}

export function revert(key) {
  store.changes.delete(key);
  setInvalid(key, null);
  emit();
}
export function discard() {
  store.changes.clear();
  store.invalid.clear();
  clearInvalidError();
  emit();
}

export function changeList() {
  return pendingKeys()
    .map((key) => ({ key, value: store.changes.get(key), invalid: store.invalid.has(key), e: entry(key) }))
    .filter((c) => c.e);
}

/** config set routes env-backed keys through the daemon.env merge as the UI does. */
export function cliOf(e, v) {
  if (e.key === "autostart") return `bastra autostart ${(v ?? e.default) ? "on" : "off"}`;
  if (v === null) return null;
  const raw = typeof v === "object" ? JSON.stringify(v) : String(v);
  const arg = /^[a-zA-Z0-9_./:@,+%-]+$/.test(raw) ? raw : `'${raw.replaceAll("'", "'\\''")}'`;
  return `bastra config set ${e.key} ${e.secret ? "'…'" : arg}`;
}

/** Search text of a row: name, key, env names, chips. */
export function matches(e, name, desc, q) {
  if (!q) return true;
  const meta = metaOf(e);
  const text = [
    name,
    e.key,
    e.envName || "",
    desc,
    ...(e.envOverride || []).map((x) => x.name),
    e.restartRequired ? "restart" : "",
    meta.experimental ? "experimental" : "",
    e.envOverride?.length ? "env" : "",
    e.secret ? "token secret" : "",
    e.local ? "ui local" : "",
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(q);
}

export { state };
