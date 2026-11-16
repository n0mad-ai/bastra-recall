// Daemon data for the shell. Every answer is external input: shapes are
// checked before use and failures leave the previous value in place.
import { reportRows } from "./sections/tasks-reports-model.js";
const listeners = new Set();

export const data = {
  health: null, // GET /ui/health
  clusters: [], // [{ key, count }] from GET /ui/graph
  edges: 0,
  weeks: [], // 52 weekly counts of memory updates, oldest first
  weekStart: null, // Date of week 0
  dueTasks: [], // tasks in state "due"
  tasks: [], // open tasks (pending | due | snoozed), for the dashboard
  reports: [], // task reports (task_report_list rows, unread first): nav dot, ticker, Tasks › Reports
  newSince: 0, // live updates since page load (all kinds, incl. reads)
  newMemories: 0, // memories created since page load (kind "add" only)
  weather: null, // { temp, city }
  vaultName: null, // vault_name from GET /ui/graph, as the user named it
  graph: null, // { nodes, edges, groups } from GET /ui/graph, for the vault views
  graphError: false, // the first graph request failed (run indicator shows it)
  tasksLoaded: false, // the first task list answered (or failed): widgets stop showing "loading"
};

function emit() {
  for (const fn of listeners) fn(data);
}
export function onData(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function getJson(url, init) {
  const r = await fetch(url, { credentials: "same-origin", ...init });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export async function loadHealth() {
  try {
    const h = await getJson("/ui/health");
    if (h && typeof h === "object") {
      data.health = h;
      emit();
    }
  } catch {
    /* keep last */
  }
}

const WEEK = 7 * 864e5;
let graphRequest = null;
export function loadGraph() {
  if (!graphRequest)
    graphRequest = fetchGraph().finally(() => {
      graphRequest = null;
    });
  return graphRequest;
}
async function fetchGraph() {
  try {
    const g = await getJson("/ui/graph");
    if (typeof g.vault_name === "string" && g.vault_name.trim()) {
      data.vaultName = g.vault_name.trim();
      document.title = `${data.vaultName} — Recall`;
    }
    // User-facing area counts describe memories/documents, not synthetic
    // ghosts or skills. Keep the graph's stable order and raw projection.
    const realCounts = new Map();
    for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
      if (n && (n.kind === "memory" || n.kind === "doc") && typeof n.cluster === "string")
        realCounts.set(n.cluster, (realCounts.get(n.cluster) || 0) + 1);
    }
    if (Array.isArray(g.clusters))
      data.clusters = g.clusters
        .filter((c) => c && typeof c.key === "string" && Number.isFinite(c.count))
        .map((c) => ({ key: c.key, count: realCounts.get(c.key) || 0 }))
        .filter((c) => c.count > 0);
    data.edges = Array.isArray(g.edges) ? g.edges.length : 0;
    // Raw nodes and edges for the vault views (js/views/vault-data.js checks the shapes).
    data.graph = {
      nodes: Array.isArray(g.nodes) ? g.nodes : [],
      edges: Array.isArray(g.edges) ? g.edges : [],
      groups: Array.isArray(g.groups) ? g.groups : [],
    };
    const now = new Date(),
      end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 864e5;
    const start = end - 52 * WEEK;
    const weeks = new Array(52).fill(0);
    for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
      if (!n || n.kind !== "memory" || typeof n.updated !== "string") continue;
      const at = Date.parse(n.updated);
      if (!Number.isFinite(at) || at < start || at >= end) continue;
      weeks[Math.min(51, Math.floor((at - start) / WEEK))]++;
    }
    data.weeks = weeks;
    data.weekStart = new Date(start);
    data.graphError = false;
    emit();
  } catch {
    if (!data.graph) {
      data.graphError = true;
      emit();
    } /* else keep last */
  }
}

// One session request at a time: loadTasks and loadReports start together, and
// two cookie-less session requests would each open a session; the browser keeps
// only the second cookie, so the first caller's CSRF token was refused and its
// list (e.g. the reports for the ticker) stayed empty until the next 60 s poll.
let taskCsrf = null,
  taskSession = null;
function taskSessionCsrf() {
  taskSession ??= getJson("/ui/tasks/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
    .then((s) => {
      taskCsrf = typeof s.csrf === "string" ? s.csrf : null;
      if (!taskCsrf) throw new Error("no task session");
      return taskCsrf;
    })
    .finally(() => {
      taskSession = null;
    });
  return taskSession;
}
async function taskApi(name, input = {}, retry = true) {
  const csrf = taskCsrf ?? (await taskSessionCsrf());
  const r = await fetch(`/ui/tasks/api/task_${name}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "x-bastra-task-csrf": csrf },
    body: JSON.stringify(input),
  });
  if (r.status === 401 || r.status === 403) {
    // Expired or replaced session (daemon restart, the Tasks area's own session request): renew once.
    if (taskCsrf === csrf) taskCsrf = null;
    if (retry) return taskApi(name, input, false);
    throw new Error("task session expired");
  }
  if (!r.ok) throw new Error(`task_${name} → ${r.status}`);
  return r.json();
}

export async function loadTasks() {
  if (document.documentElement.dataset.tasksEnabled !== "true") return;
  try {
    const b = await taskApi("list");
    const tasks = Array.isArray(b.tasks) ? b.tasks : [];
    data.dueTasks = tasks.filter((t) => t && t.state === "due" && !t.archived && typeof t.goal === "string");
    data.tasks = tasks.filter(
      (t) => t && !t.archived && typeof t.goal === "string" && ["pending", "due", "snoozed"].includes(t.state)
    );
    data.tasksLoaded = true;
    emit();
  } catch {
    if (!data.tasksLoaded) {
      data.tasksLoaded = true;
      emit();
    } /* else keep last */
  }
}

/** Task reports for the nav dot, the ticker and the Tasks area; rides on the task polling. */
export async function loadReports() {
  if (document.documentElement.dataset.tasksEnabled !== "true") return;
  try {
    const next = reportRows(await taskApi("report_list"));
    if (JSON.stringify(next) === JSON.stringify(data.reports)) return;
    data.reports = next;
    emit();
  } catch {
    /* keep last; an older daemon has no reports */
  }
}

export function dueAt(t) {
  return t.snoozed_until ?? t.next_slot?.at ?? t.schedule?.at ?? t.next_check_at;
}

let seq = null;
const updateListeners = new Set();
/** Fresh vault events from GET /ui/updates (add | change | delete | read), as delivered. */
export function onUpdates(fn) {
  updateListeners.add(fn);
  return () => updateListeners.delete(fn);
}
let updatesRequest = null;
export function pollUpdates() {
  if (!updatesRequest)
    updatesRequest = fetchUpdates().finally(() => {
      updatesRequest = null;
    });
  return updatesRequest;
}
async function fetchUpdates() {
  try {
    const u = await getJson(seq === null ? "/ui/updates" : `/ui/updates?since=${seq}`);
    if (typeof u.seq !== "number") return;
    const fresh = seq !== null && u.seq > seq && Array.isArray(u.updates) ? u.updates : [];
    seq = u.seq;
    if (fresh.length) {
      data.newSince += fresh.length;
      data.newMemories += fresh.filter((x) => x && x.kind === "add").length;
      emit();
      for (const fn of updateListeners) fn(fresh);
      if (fresh.some((x) => x && ["add", "change", "delete"].includes(x.kind))) {
        // One refresh for the entire batch. If the initial graph is still in
        // flight, let it finish before fetching the post-update snapshot.
        if (graphRequest) await graphRequest;
        await loadGraph();
      }
    }
  } catch {
    /* keep last */
  }
}

/** POST /ui/chat — { message, history, conversation_id, area?, lang? } → { reply, hits, conversation_id, navigate? }.
 *  Without a conversation id the daemon starts a new stored conversation. */
export async function chat(message, history, conversationId, area, lang) {
  const r = await fetch("/ui/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history,
      conversation_id: conversationId || undefined,
      area: area || undefined,
      lang: lang || undefined,
    }),
  });
  const b = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: b };
}

// Weather: the place is the one the user already picked in the map
// (same origin, same storage key); only the current temperature is read.
const PLACE_KEY = "bastra-vault-map-weather-place";
export async function loadWeather() {
  let place = null;
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
    if (p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon)) place = p;
  } catch {
    /* blocked */
  }
  if (!place) {
    data.weather = null;
    emit();
    return;
  }
  try {
    const w = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${+place.lat}&longitude=${+place.lon}&current=temperature_2m,weather_code`,
      { credentials: "omit" }
    );
    const temp = w?.current?.temperature_2m;
    if (Number.isFinite(temp)) {
      data.weather = { temp, city: typeof place.name === "string" ? place.name.split(",")[0] : "" };
      emit();
    }
  } catch {
    /* keep last */
  }
}

export function startPolling() {
  loadHealth();
  loadGraph();
  loadTasks();
  loadReports();
  pollUpdates();
  loadWeather();
  setInterval(() => {
    if (!document.hidden) {
      pollUpdates();
    }
  }, 5000);
  setInterval(() => {
    if (!document.hidden) {
      loadTasks();
      loadReports();
      loadHealth();
    }
  }, 60000);
  setInterval(() => {
    if (!document.hidden) loadWeather();
  }, 15 * 60000);
}
