// Daemon data for the shell. Every answer is external input: shapes are
// checked before use and failures leave the previous value in place.
const listeners = new Set();

export const data = {
  health: null,     // GET /ui/health
  clusters: [],     // [{ key, count }] from GET /api/v1/graph
  edges: 0,
  weeks: [],        // 52 weekly counts of memory updates, oldest first
  weekStart: null,  // Date of week 0
  dueTasks: [],     // tasks in state "due"
  newSince: 0,      // live updates since page load
  weather: null,    // { temp, city }
};

function emit() { for (const fn of listeners) fn(data); }
export function onData(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function getJson(url, init) {
  const r = await fetch(url, { credentials: "same-origin", ...init });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export async function loadHealth() {
  try { const h = await getJson("/ui/health"); if (h && typeof h === "object") { data.health = h; emit(); } } catch { /* keep last */ }
}

const WEEK = 7 * 864e5;
export async function loadGraph() {
  try {
    const g = await getJson("/api/v1/graph");
    if (Array.isArray(g.clusters)) data.clusters = g.clusters.filter((c) => c && typeof c.key === "string" && Number.isFinite(c.count));
    data.edges = Array.isArray(g.edges) ? g.edges.length : 0;
    const now = new Date(), end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 864e5;
    const start = end - 52 * WEEK;
    const weeks = new Array(52).fill(0);
    for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
      if (!n || n.kind !== "memory" || typeof n.updated !== "string") continue;
      const at = Date.parse(n.updated);
      if (!Number.isFinite(at) || at < start || at >= end) continue;
      weeks[Math.min(51, Math.floor((at - start) / WEEK))]++;
    }
    data.weeks = weeks; data.weekStart = new Date(start);
    emit();
  } catch { /* keep last */ }
}

let taskCsrf = null;
async function taskApi(name, input = {}) {
  if (!taskCsrf) {
    const s = await getJson("/ui/tasks/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    taskCsrf = typeof s.csrf === "string" ? s.csrf : null;
    if (!taskCsrf) throw new Error("no task session");
  }
  const r = await fetch(`/ui/tasks/api/task_${name}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-bastra-task-csrf": taskCsrf }, body: JSON.stringify(input) });
  if (r.status === 401 || r.status === 403) { taskCsrf = null; throw new Error("task session expired"); }
  if (!r.ok) throw new Error(`task_${name} → ${r.status}`);
  return r.json();
}

export async function loadTasks() {
  if (document.documentElement.dataset.tasksEnabled !== "true") return;
  try {
    const b = await taskApi("list");
    const tasks = Array.isArray(b.tasks) ? b.tasks : [];
    data.dueTasks = tasks.filter((t) => t && t.state === "due" && !t.archived && typeof t.goal === "string");
    emit();
  } catch { /* keep last */ }
}

export function dueAt(t) { return t.snoozed_until ?? t.next_slot?.at ?? t.schedule?.at ?? t.next_check_at; }

let seq = null;
export async function pollUpdates() {
  try {
    const u = await getJson(seq === null ? "/ui/updates" : `/ui/updates?since=${seq}`);
    if (typeof u.seq !== "number") return;
    if (seq !== null && u.seq >= seq && Array.isArray(u.updates) && u.updates.length) { data.newSince += u.updates.length; emit(); }
    seq = u.seq;
  } catch { /* keep last */ }
}

/** POST /ui/chat — { message, history } → { reply, … }. */
export async function chat(message, history) {
  const r = await fetch("/ui/chat", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history }) });
  const b = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: b };
}

// Weather: the place is the one the user already picked in the map
// (same origin, same storage key); only the current temperature is read.
const PLACE_KEY = "bastra-vault-map-weather-place";
export async function loadWeather() {
  let place = null;
  try { const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null"); if (p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon)) place = p; } catch { /* blocked */ }
  if (!place) { data.weather = null; emit(); return; }
  try {
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${+place.lat}&longitude=${+place.lon}&current=temperature_2m,weather_code`, { credentials: "omit" });
    const temp = w?.current?.temperature_2m;
    if (Number.isFinite(temp)) { data.weather = { temp, city: typeof place.name === "string" ? place.name.split(",")[0] : "" }; emit(); }
  } catch { /* keep last */ }
}

export function startPolling() {
  loadHealth(); loadGraph(); loadTasks(); pollUpdates(); loadWeather();
  setInterval(() => { if (!document.hidden) { pollUpdates(); } }, 5000);
  setInterval(() => { if (!document.hidden) { loadTasks(); loadHealth(); } }, 60000);
  setInterval(() => { if (!document.hidden) loadWeather(); }, 15 * 60000);
}
