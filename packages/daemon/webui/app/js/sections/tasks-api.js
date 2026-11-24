// Tasks area — daemon access and the task model the calendar works with.
// Every answer from /ui/tasks/… is external input: shapes are checked before
// use, and task text is only ever rendered as text (never HTML).
//
// Endpoints are the ones the old UI uses (webui/js/tasks.js): a local browser
// session (POST /ui/tasks/session → csrf) and POST /ui/tasks/api/task_<op>.
import { t, LANG } from "../i18n.js";
import { taskSession, taskRequest } from "../session-client.js";

function tasksCsrf({ response, body: b = {} }) {
  if (!response.ok || typeof b.csrf !== "string")
    throw Object.assign(new Error(t("tk.err.offline")), { code: b.code || "offline" });
  return b.csrf;
}

/** POST /ui/tasks/api/task_<name>. Errors carry the daemon code and a readable message. */
export function api(name, input = {}, retry = true) {
  return taskSession.run(
    tasksCsrf,
    async (csrf, { renew }) => {
      const r = await taskRequest(name, input, csrf);
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (renew && (r.status === 401 || r.status === 403 || b.code === "unauthorized")) return renew();
        const key = `tk.err.${b.code}`,
          msg = t(key);
        throw Object.assign(new Error(msg === key ? t("tk.err.generic") : msg), { code: b.code });
      }
      return b;
    },
    retry
  );
}

/** get → op with the current expected_revision (old UI mutate()). */
export async function mutate(id, op, extra = {}) {
  const cur = await api("get", { id });
  return api(op, { id, expected_revision: cur.expected_revision, ...extra });
}

// ── time ──────────────────────────────────────────────────────────────────
export const LOCALE = LANG === "de" ? "de-DE" : "en-GB";
export const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/** "Mi., 28.10.2026, 14:00" in the task's time zone (old UI time()). */
export function fmtAt(at, tz) {
  if (!Number.isFinite(at)) return t("tk.none");
  try {
    return new Intl.DateTimeFormat(LOCALE, {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || BROWSER_TZ,
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

/** Wall-clock parts of an instant in a time zone, "YYYY-MM-DDTHH:mm:ss". */
export function localParts(at, tz) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (k) => p.find((v) => v.type === k).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Local wall time in tz → calendar schedule (old UI makeInput, kind "when"). The server re-resolves it. */
export function calendarSchedule(when, tz) {
  const local = when.length === 16 ? `${when}:00` : when,
    wall = Date.parse(`${local}Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local) || !Number.isFinite(wall))
    throw new Error(t("tk.err.localTime"));
  const offsets = new Set();
  for (let hh = -36; hh <= 36; hh += 6) {
    const sample = wall + hh * 3600000;
    offsets.add(Date.parse(`${localParts(sample, tz)}Z`) - sample);
  }
  const choices = [...offsets]
    .map((o) => ({ at: wall - o, offset_minutes: o / 60000 }))
    .filter((c) => localParts(c.at, tz) === local)
    .sort((a, b) => a.at - b.at);
  if (!choices.length) throw new Error(t("tk.err.gap"));
  return {
    schedule: { kind: "calendar", local_time: local, timezone: tz, gap: "reject", overlap: "earlier", ...choices[0] },
    ambiguous: choices.length > 1,
  };
}

/** A browser-local instant (calendar drop) as a calendar schedule in the task's own zone. */
export function scheduleAt(at, tz) {
  return calendarSchedule(localParts(at, tz), tz).schedule;
}

/** Duration "30m | 2h | 7d | 2w" → ms, or null. */
export function durationMs(v) {
  const m = /^(\d+)(m|h|d|w)$/.exec(String(v).trim());
  return m ? +m[1] * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2]] : null;
}

/** Create input exactly as the old UI builds it (makeInput + recurrence + expiry). */
export function createInput(F, role, tasks = []) {
  const goal = F.goal.trim();
  if (!goal) throw new Error(t("tk.err.goal"));
  const tz = F.tz.trim() || BROWSER_TZ;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error(t("tk.err.tz"));
  }
  let schedule,
    arm = F.arm,
    note = "";
  if (F.timing === "after") {
    const ms = durationMs(F.when);
    if (ms === null) throw new Error(t("tk.err.duration"));
    const now = Date.now();
    schedule = { kind: "duration", reference_at: now, duration_ms: ms, at: now + ms };
  } else {
    const r = calendarSchedule(F.when.trim(), tz);
    schedule = r.schedule;
    if (r.ambiguous) {
      arm = false;
      note = t("tk.msg.ambiguous");
    }
  }
  const domains = F.domain
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (!domains.length) throw new Error(t("tk.err.domain"));
  const input = {
    idempotency_key: crypto.randomUUID(),
    original_request: goal,
    goal,
    resolution_condition: "Owner bestätigt Erledigung",
    schedule,
    timezone: tz,
    scope: { kind: "personal", name: domains[0] },
    owner_domains: domains,
    action_level: F.level,
    arm,
  };
  if (F.expires.trim()) input.expires_at = calendarSchedule(F.expires.trim(), tz).schedule.at;
  if (F.every.trim()) {
    const m = /^(\d+)(d|w)$/.exec(F.every.trim());
    if (!m) throw new Error(t("tk.err.every"));
    const cal = schedule.kind === "calendar";
    input.recurrence = {
      kind: cal ? "calendar" : "elapsed",
      interval: +m[1] * (cal ? (m[2] === "w" ? 7 : 1) : m[2] === "w" ? 604800000 : 86400000),
      ...(String(F.count).trim() ? { count: +F.count } : {}),
      catch_up: "latest",
    };
  }
  if (role === "agent")
    input.origin = { kind: "user-request", client: "recall-ui", session: "local-browser", context: goal };
  Object.assign(input, boardFields(F, tasks));
  return { input, note };
}

// ── board fields (Daniel 12.11.2026): waits_on, source, agent_note, assignee.
// The area is the existing scope.name. All optional on the daemon side.
// waits_on entries are task ids (prototype TK_DEPS) or free text ("Antwort von Lena").
export const splitWaits = (v) =>
  String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Typed entries → stored entries: the exact goal of a known task becomes its id. */
export function resolveWaits(entries, tasks = []) {
  return entries.map((e) => (tasks.find((x) => x.id === e) ? e : (tasks.find((x) => x.goal === e)?.id ?? e)));
}
/** Stored entries → [{ text, done, task }]: task ids show the goal, a finished task counts as done. */
export function waitsView(task, tasks = []) {
  return (Array.isArray(task.waits_on) ? task.waits_on : [])
    .filter((e) => typeof e === "string")
    .map((e) => {
      const dep = tasks.find((x) => x.id === e);
      return { text: dep ? dep.goal : e, done: !!dep && isTerminal(dep), task: dep || null };
    });
}

/** Form values → board fields of a create input; empty values are left out. */
export function boardFields(F, tasks = []) {
  const out = {},
    waits = resolveWaits(splitWaits(F.waits), tasks),
    ref = String(F.srcRef ?? "").trim(),
    note = String(F.note ?? "").trim();
  if (waits.length) out.waits_on = waits;
  if (F.srcKind) {
    if (!ref) throw new Error(t("tk.err.srcRef"));
    out.source = { kind: F.srcKind, ref };
  }
  if (note) out.agent_note = note;
  if (F.assignee === "user" || F.assignee === "recall") out.assignee = F.assignee;
  return out;
}

/** Form values → task_edit patch with only what changed; cleared values become null / []. */
export function boardPatch(task, F, tasks = []) {
  const patch = {},
    waits = resolveWaits(splitWaits(F.waits), tasks),
    ref = String(F.srcRef ?? "").trim(),
    note = String(F.note ?? "").trim();
  if (JSON.stringify(waits) !== JSON.stringify(task.waits_on ?? [])) patch.waits_on = waits;
  if (F.srcKind && !ref) throw new Error(t("tk.err.srcRef"));
  const src = F.srcKind ? { kind: F.srcKind, ref } : null;
  if (JSON.stringify(src) !== JSON.stringify(task.source ?? null)) patch.source = src;
  if (note !== (task.agent_note ?? "")) patch.agent_note = note || null;
  const who = F.assignee === "user" || F.assignee === "recall" ? F.assignee : null;
  if (who !== (task.assignee ?? null)) patch.assignee = who;
  return patch;
}

/** Task → form values of the board fields (edit form). */
export const boardForm = (task, tasks = []) => ({
  waits: waitsView(task, tasks)
    .map((w) => w.text)
    .join(", "),
  srcKind: task.source?.kind ?? "",
  srcRef: task.source?.ref ?? "",
  note: task.agent_note ?? "",
  assignee: task.assignee ?? "",
});

/**
 * Who holds the task now: the set assignee, otherwise derived from state,
 * arming and level (due, awaiting release and snoozed are with the user).
 */
export function holderOf(task, k) {
  if (task.assignee === "user" || task.assignee === "recall") return { who: task.assignee, set: true };
  const who =
    k === "done" || k === "failed"
      ? task.origin?.kind === "agent-observed" && task.action_level !== "notify"
        ? "recall"
        : "user"
      : k === "due" || k === "await" || k === "snoozed"
        ? "user"
        : "recall";
  return { who, set: false };
}

// ── task model ────────────────────────────────────────────────────────────
const TERMINAL = new Set(["resolved", "cancelled", "expired"]);
export const isTerminal = (task) => TERMINAL.has(task.state);
export function dueAt(task) {
  return task.snoozed_until ?? task.next_slot?.at ?? task.schedule?.at ?? task.next_check_at;
}

// Stored failure and review texts are English product text (#1602). Shown by their fixed code or,
// where several texts share a code or there is none, by the exact stored text; anything else
// (an unknown code, a text from an older version) stays as stored.
const STORED = {
  "Memory scan limit exceeded": "tk.reason.memory_scan",
  "File source has several hard links; only files with a single link are observed": "tk.reason.source_hardlink",
  "Execution failed or reconciliation required": "tk.reason.archive_failed",
  "Explicit owner review required": "tk.review.explicit",
  "Owner review required before arming": "tk.review.explicit",
  "Edited binding requires explicit owner review": "tk.review.edited",
  "Recovered snapshot requires owner review": "tk.review.recovered",
  "Conversational reminders disabled; saved unarmed": "tk.review.remindersOff",
  "Confirmed decision change pending; old watch disarmed": "tk.review.decisionPending",
  "Kept decision; further premise changes require owner rebinding": "tk.review.decisionKept",
  "Decision changed; old binding retained, new monitoring requires owner review": "tk.review.decisionChanged",
  "Private binding retired; prepare again": "tk.review.bindingRetired",
  "Reconciliation required: execution outcome unknown": "tk.card.reconcileUnknown",
};
function storedText(text, code) {
  for (const key of [STORED[text], code && `tk.reason.${code}`]) {
    if (!key) continue;
    const s = t(key);
    if (s !== key) return s;
  }
  return text || code || "";
}
/** last_failure ({ code, message }) in the UI language. */
export const failureText = (f) => storedText(f.message, f.code);
/** review_reason: a fixed sentence or, for a bound decision, its code. */
export const reviewText = (v) => storedText(v, v);

/** Old UI taskFailureReason(). */
export function failureReason(task, snap) {
  if (task.state === "cancelled" || task.state === "expired") return t(`tk.state.${task.state}`);
  if (task.archive_failure) return storedText(String(task.archive_failure));
  if (task.archived) return "";
  const i = (snap.intents || []).filter((x) => x.task_id === task.id).at(-1),
    r = (snap.receipts || []).filter((x) => x.task_id === task.id).at(-1);
  if (i && ["pending", "unknown"].includes(i.state)) return t("tk.fail.intent");
  if (r?.outcome === "failed") return t("tk.fail.receipt");
  if (task.verification?.outcome === "unavailable") return t("tk.fail.source");
  return "";
}

/** Old UI columnFor(); the calendar splits "planned" into planned/await. */
export function keyOf(task, snap) {
  let col;
  if (task.paused) col = "snoozed";
  else if (failureReason(task, snap)) col = "failed";
  else
    col =
      { pending: "planned", due: "due", snoozed: "snoozed", resolved: "done", cancelled: "failed", expired: "failed" }[
        task.state
      ] || "planned";
  return col === "planned" && !task.armed ? "await" : col;
}

export function originLabel(task) {
  if (task.origin) return task.origin.kind === "user-request" ? t("tk.origin.user") : t("tk.origin.agent");
  const r = task.request_source;
  return r === "owner-command" || r === "user-request"
    ? t("tk.origin.user")
    : r === "agent-proposal" || r === "agent-observed"
      ? t("tk.origin.agent")
      : t("tk.origin.none");
}

/** Old UI canMove(). */
export function canMove(task, target) {
  if (task.archived) return false;
  const term = isTerminal(task);
  if (target === "planned") return term;
  if (term) return false;
  if (target === "done") return !task.recurrence || (task.deliveries || []).some((d) => !d.resolved);
  return target === "snoozed" || target === "failed";
}

const okTask = (x) =>
  x &&
  typeof x === "object" &&
  typeof x.id === "string" &&
  typeof x.goal === "string" &&
  typeof x.state === "string" &&
  x.schedule &&
  typeof x.schedule === "object";

/**
 * Snapshot → calendar items: { t, id, k, at, date, h } — at/date/h are null
 * for tasks without a date (event triggers), which go to the tray.
 */
export function itemsOf(snap, cold = []) {
  const seen = new Set(),
    out = [];
  for (const task of [...(snap.tasks || []), ...cold]) {
    if (!okTask(task)) continue;
    const key = task.archived ? `a:${task.archive_id ?? ""}:${task.id}` : task.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const noDate = task.schedule.kind === "event" && !Number.isFinite(task.snoozed_until);
    const at = noDate ? null : dueAt(task);
    const ok = Number.isFinite(at);
    const date = ok ? new Date(at) : null;
    out.push({
      t: task,
      id: key,
      k: keyOf(task, snap),
      at: ok ? at : null,
      date,
      h: ok ? date.getHours() + date.getMinutes() / 60 : null,
    });
  }
  return out;
}

// ── weather per day (open-meteo daily, same place the map uses) ──────────
const PLACE_KEY = "bastra-vault-map-weather-place";
let wx = { at: 0, days: {} };
export function weatherDays() {
  return wx.days;
}
export async function loadWeatherDays() {
  if (Date.now() - wx.at < 30 * 60000) return false;
  let place = null;
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
    if (p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon)) place = p;
  } catch {
    /* blocked */
  }
  wx.at = Date.now();
  if (!place) {
    wx.days = {};
    return false;
  }
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${+place.lat}&longitude=${+place.lon}&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=16&timezone=auto`,
      { credentials: "omit" }
    );
    const w = await r.json();
    const d = w?.daily,
      days = {};
    if (d && Array.isArray(d.time))
      d.time.forEach((day, i) => {
        const hi = d.temperature_2m_max?.[i],
          lo = d.temperature_2m_min?.[i],
          code = d.weather_code?.[i];
        if (typeof day === "string" && Number.isFinite(hi) && Number.isFinite(lo))
          days[day] = {
            hi: Math.round(hi),
            lo: Math.round(lo),
            kind: !Number.isFinite(code) ? "cloud" : code <= 1 ? "sun" : code >= 51 ? "rain" : "cloud",
          };
      });
    wx.days = days;
    return true;
  } catch {
    return false;
  }
}
