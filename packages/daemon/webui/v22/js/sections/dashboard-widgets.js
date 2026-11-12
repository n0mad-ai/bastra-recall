// Dashboard widgets of the free build: Today, Weather, Tasks, Deadlines,
// Memory (prototype W-00, W-01, W-02, W-04, W-07). Mail, Week/Calendar and
// Coding agents are Pro and come in through window.recallUi.registerWidget().
//
// A widget is { type, code, titleKey|title, descKey|desc, icon, w, h, minW,
// minH, render(body, env) → { meta?, tone? } }. env: { item, wPx, hPx, rowH,
// now, ctx, go(patch), redraw() }. tone: "amber" | "accent" | "muted" (meta colour).
import { h, s } from "../dom.js";
import { t, LANG, numberFmt } from "../i18n.js";
import { data, dueAt } from "../data.js";

const LOCALE = LANG === "de" ? "de-DE" : "en-US";
const DAY = 864e5;
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** ISO 8601 week number (prototype "KW 44"). */
export function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  return Math.ceil(((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}

const wdShort = (d) => d.toLocaleDateString(LOCALE, { weekday: "short" }).replace(".", "");
const dateShort = (d) => d.toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit" });

// ── tasks (data.tasks: open tasks from task_list) ─────────────────────────
function taskAt(task) { const at = dueAt(task); return Number.isFinite(at) ? at : null; }

/** Open tasks: due first (oldest first), then by next time, untimed last. */
export function openTasks() {
  return data.tasks.slice().sort((a, b) => {
    const da = a.state === "due" ? 0 : 1, db = b.state === "due" ? 0 : 1;
    if (da !== db) return da - db;
    return (taskAt(a) ?? Infinity) - (taskAt(b) ?? Infinity);
  });
}

function whenText(task, now) {
  const at = taskAt(task);
  if (at === null) return t("db.when.event");
  const d = new Date(at), today = startOfDay(now).getTime();
  if (task.state === "due" || at <= now.getTime()) return t("db.when.since", { t: at >= today ? hhmm(d) : `${dateShort(d)} ${hhmm(d)}` });
  if (at < today + DAY) return t("db.when.today", { t: hhmm(d) });
  if (at < today + 2 * DAY) return t("db.when.tomorrow", { t: hhmm(d) });
  return `${wdShort(d)} ${dateShort(d)} ${hhmm(d)}`;
}

const LEVEL = { notify: "db.lvl.notify", prepare: "db.lvl.prepare", execute: "db.lvl.execute" };
const levelTag = (task) => (LEVEL[task.action_level] ? t(LEVEL[task.action_level]) : String(task.action_level || "").toUpperCase());

/** Deadlines: open tasks with a due time, nearest first; days = whole days left. */
export function deadlines(now) {
  const today = startOfDay(now).getTime();
  return data.tasks.map((task) => ({ task, at: taskAt(task) })).filter((x) => x.at !== null)
    .sort((a, b) => a.at - b.at)
    .map((x) => ({ ...x, days: Math.max(0, Math.round((startOfDay(new Date(x.at)).getTime() - today) / DAY)) }));
}

const tasksOn = () => document.documentElement.dataset.tasksEnabled === "true";
const empty = (text) => h("p.dw-empty", { text });

// ── W-00 Today ────────────────────────────────────────────────────────────
const hp = (x) => `${(((Math.min(22, Math.max(6, x)) - 6) / 16) * 100).toFixed(1)}%`;

function renderBriefing(body, env) {
  const { now, go, wPx, item } = env;
  const open = openTasks(), due = open.filter((x) => x.state === "due").length;
  const dayEnd = startOfDay(now).getTime() + DAY;
  const later = open.filter((x) => { const at = taskAt(x); return x.state !== "due" && at !== null && at > now.getTime() && at < dayEnd; });
  const dl = deadlines(now).find((x) => x.at > now.getTime());
  const stats = [
    [String(due), t("db.b.due"), due ? "var(--amber)" : "var(--ink)", () => go({ view: "tasks" })],
    [String(later.length), t("db.b.today"), "var(--ink)", () => go({ view: "tasks" })],
    [dl ? `${dl.days} d` : "—", t("db.b.next"), "var(--ink)", () => go({ view: "tasks" })],
    [String(memoryStats(now).week), t("db.b.new"), "var(--accent)", () => go({ view: "chronos" })],
  ];
  body.append(h("div.dw-brief", null,
    h("div.dw-stats", { cls: wPx >= 520 ? "is-4" : "" }, stats.map(([v, k, c, on]) =>
      h("button.dw-stat", { vars: { "--c": c }, on: { click: on } }, h("span.dw-stat__v", { text: v }), h("span.dw-stat__k", { text: k })))),
    item.h >= 3 ? dayLine(now, open) : null,
    h("button.dw-ask", { text: t("db.b.ask"), on: { click: () => env.ctx.ask(t("agent.sug.brief")) } })));
  return { meta: t("db.b.meta", { time: hhmm(now), w: isoWeek(now) }) };
}

function dayLine(now, open) {
  const day0 = startOfDay(now).getTime(), hour = (now.getTime() - day0) / 36e5;
  const events = open.map((x) => ({ x, at: taskAt(x) })).filter((e) => e.at !== null && e.at >= day0 && e.at < day0 + DAY);
  return h("div.dw-day", { vars: { "--now": hp(hour) } },
    h("span.dw-day__line"), h("span.dw-day__done"),
    events.map((e) => h("span.dw-day__ev", { title: e.x.goal, vars: { "--x": hp((e.at - day0) / 36e5), "--c": e.x.state === "due" ? "var(--amber)" : "var(--accent)" } }, h("span"))),
    h("span.dw-day__now"),
    h("div.dw-day__scale", null, ["06", "10", "14", "18", "22"].map((x) => h("span", { text: x }))));
}

// ── W-01 Weather ──────────────────────────────────────────────────────────
// Place: the one the user picked in the classic UI (same origin, same key).
const PLACE_KEY = "bastra-vault-map-weather-place";
let wx = { key: "", at: 0, state: "idle", data: null };

function readPlace() {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
    if (p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon)) return { lat: +p.lat, lon: +p.lon, name: typeof p.name === "string" ? p.name.split(",")[0] : "" };
  } catch { /* storage blocked */ }
  return null;
}

async function loadWeather(place, redraw) {
  const key = `${place.lat},${place.lon}`;
  if (wx.state === "loading" || (wx.key === key && Date.now() - wx.at < 15 * 60000)) return;
  wx = { ...wx, key, state: "loading" };
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}`
      + "&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m,wind_direction_10m"
      + "&hourly=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max"
      + "&timezone=auto&forecast_days=6";
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) throw new Error(String(r.status));
    const parsed = parseWeather(await r.json());
    wx = { key, at: Date.now(), state: parsed ? "ok" : "err", data: parsed };
  } catch {
    wx = { key, at: Date.now(), state: wx.data ? "ok" : "err", data: wx.data };
  }
  redraw();
}

const num = (v) => (Number.isFinite(v) ? v : null);
// open-meteo local times ("2026-11-12T07:45") — hours and minutes as numbers.
const clock = (s) => { const m = /T(\d\d):(\d\d)/.exec(typeof s === "string" ? s : ""); return m ? +m[1] + +m[2] / 60 : null; };

function parseWeather(j) {
  const c = j?.current, d = j?.daily, hr = j?.hourly;
  if (!c || num(c.temperature_2m) === null || !d || !Array.isArray(d.time)) return null;
  // Next twelve hours from the current local hour.
  let hours = [];
  if (hr && Array.isArray(hr.time) && Array.isArray(hr.temperature_2m) && typeof c.time === "string") {
    const i0 = Math.max(0, hr.time.findIndex((x) => typeof x === "string" && x.slice(0, 13) > c.time.slice(0, 13)));
    hours = hr.time.slice(i0, i0 + 12).map((x, i) => ({ h: String(x).slice(11, 13), t: num(hr.temperature_2m[i0 + i]) })).filter((x) => x.t !== null);
  }
  const days = d.time.slice(1, 6).map((x, i) => ({
    date: new Date(`${x}T12:00:00`), code: num(d.weather_code?.[i + 1]), lo: num(d.temperature_2m_min?.[i + 1]), hi: num(d.temperature_2m_max?.[i + 1]),
  })).filter((x) => x.lo !== null && x.hi !== null);
  return {
    temp: c.temperature_2m, code: num(c.weather_code), hum: num(c.relative_humidity_2m), wind: num(c.wind_speed_10m), dir: num(c.wind_direction_10m),
    hi: num(d.temperature_2m_max?.[0]), lo: num(d.temperature_2m_min?.[0]), rain: num(d.precipitation_probability_max?.[0]),
    sunA: clock(d.sunrise?.[0]), sunB: clock(d.sunset?.[0]), sunrise: String(d.sunrise?.[0] ?? "").slice(11, 16), sunset: String(d.sunset?.[0] ?? "").slice(11, 16),
    nowH: clock(c.time), tz: typeof j.timezone === "string" ? j.timezone : "", hours, days,
  };
}

// WMO 4677 codes (open-meteo) → long condition and short day label.
function cond(code) {
  if (code === null) return ["", ""];
  if (code === 0) return ["clear", "clear"];
  if (code === 1) return ["mainly", "clear"];
  if (code === 2) return ["partly", "cloudy"];
  if (code === 3) return ["overcast", "cloudy"];
  if (code === 45 || code === 48) return ["fog", "fog"];
  if (code >= 51 && code <= 57) return ["drizzle", "drizzle"];
  if (code === 66 || code === 67) return ["freezing", "rain"];
  if (code >= 61 && code <= 65) return ["rain", "rain"];
  if (code >= 71 && code <= 77) return ["snow", "snow"];
  if (code >= 80 && code <= 82) return ["showers", "rain"];
  if (code === 85 || code === 86) return ["snowShowers", "snow"];
  if (code >= 95) return ["storm", "storm"];
  return ["", ""];
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const deg = (v) => (v === null ? "—" : `${Math.round(v)}°`);

function renderWeather(body, env) {
  const place = readPlace();
  if (!place) { body.append(h("div.dw-note", null, h("span", { text: t("db.wx.none") }), h("span.dw-note__sub", { text: t("db.wx.noneHint") }))); return { meta: "" }; }
  loadWeather(place, env.redraw);
  const W = wx.key === `${place.lat},${place.lon}` ? wx.data : null;
  if (!W) { body.append(empty(t(wx.state === "err" ? "db.wx.err" : "db.wx.loading"))); return { meta: place.name }; }
  const { item, wPx, hPx } = env, hh = item.h;
  const [cl] = cond(W.code);
  const top = h("div.dw-wx__top", null,
    h("div.dw-wx__now", null,
      h("div.dw-wx__t", { cls: hh >= 3 && wPx >= 420 ? "is-big" : "" }, h("span.dw-wx__deg", { text: String(Math.round(W.temp)) }), h("span.dw-wx__unit", { text: "°C" })),
      h("div.dw-wx__cond", { text: cl ? t(`db.wx.c.${cl}`) : "" }),
      h("div.dw-wx__hilo", { text: t("db.wx.hilo", { hi: deg(W.hi), lo: deg(W.lo) }) })),
    wPx >= 440 && W.sunA !== null && W.sunB !== null ? sunArc(W, hh) : null,
    wPx >= 700 ? h("div.dw-wx__facts", null,
      [[t("db.wx.rain"), W.rain === null ? "—" : `${W.rain} %`],
        [t("db.wx.wind"), W.wind === null ? "—" : `${Math.round(W.wind)} km/h${W.dir === null ? "" : " " + COMPASS[Math.round(W.dir / 45) % 8]}`],
        [t("db.wx.hum"), W.hum === null ? "—" : `${W.hum} %`]].map(([k, v]) => [h("span.dw-wx__fk", { text: k }), h("span", { text: v })])) : null);
  body.append(h("div.dw-wx", null, top,
    hh >= 3 && hPx >= 250 && W.hours.length > 1 ? hourCurve(W.hours) : null,
    hh >= 4 && hPx >= 400 && W.days.length ? dayStrip(W.days) : null));
  return { meta: t("db.wx.meta", { place: place.name, tz: W.tz }) };
}

function sunArc(W, hh) {
  const sp = Math.min(1, Math.max(0, ((W.nowH ?? 12) - W.sunA) / (W.sunB - W.sunA))), ang = Math.PI * (1 - sp);
  const dl = W.sunB - W.sunA, dlH = Math.floor(dl), dlM = Math.round((dl - dlH) * 60);
  const x = (100 + 90 * Math.cos(ang)).toFixed(1), y = (86 - 90 * Math.sin(ang)).toFixed(1);
  const arc = "M 10 86 A 90 90 0 0 1 190 86";
  return h("div.dw-wx__arc", { cls: hh >= 4 ? "is-tall" : "" },
    s("svg", { viewBox: "0 -18 200 110", "shape-rendering": "geometricPrecision" },
      s("path.dw-wx__arc-dash", { d: arc }),
      s("path.dw-wx__arc-sun", { d: arc, pathLength: 100, "stroke-dasharray": `${(sp * 100).toFixed(1)} 100` }),
      s("line.dw-wx__arc-base", { x1: 0, y1: 86.5, x2: 200, y2: 86.5 }),
      s("circle.dw-wx__halo", { cx: x, cy: y, r: 13 }),
      s("circle.dw-wx__sun", { cx: x, cy: y, r: 5 })),
    h("div.dw-wx__arc-k", null, h("span", { text: `↑ ${W.sunrise}` }), h("span", { text: t("db.wx.light", { h: dlH, m: dlM }) }), h("span", { text: `↓ ${W.sunset}` })));
}

function hourCurve(hours) {
  const temps = hours.map((x) => x.t), lo = Math.min(...temps), hi = Math.max(...temps);
  const pts = temps.map((v, i) => `${((i / (temps.length - 1)) * 120).toFixed(1)} ${(34 - ((v - lo) / (hi - lo || 1)) * 26).toFixed(1)}`);
  const line = "M " + pts.join(" L ");
  return h("div.dw-wx__hours", null,
    s("svg", { viewBox: "0 0 120 40", preserveAspectRatio: "none" },
      s("path.dw-wx__area", { d: `${line} L 120 40 L 0 40 Z` }),
      s("path.dw-wx__curve", { d: line, "vector-effect": "non-scaling-stroke" })),
    h("div.dw-wx__hgrid", { vars: { "--n": hours.length } }, hours.map((x) =>
      h("span.dw-wx__h", null, h("span.dw-wx__ht", { text: `${Math.round(x.t)}°` }), h("span.dw-wx__hh", { text: x.h })))));
}

function dayStrip(days) {
  const lo = Math.min(...days.map((d) => d.lo)) - 2, span = Math.max(1, Math.max(...days.map((d) => d.hi)) - lo + 2);
  return h("div.dw-wx__days", null, days.map((d) => {
    const [, sh] = cond(d.code);
    return h("div.dw-wx__day", null,
      h("span.dw-wx__dh", null, h("span", { text: wdShort(d.date).toUpperCase() }), h("span.dw-wx__dc", { text: sh ? t(`db.wx.s.${sh}`) : "" })),
      h("span.dw-wx__bar", null, h("span", { vars: { "--l": `${(((d.lo - lo) / span) * 100).toFixed(0)}%`, "--w": `${(((d.hi - d.lo) / span) * 100).toFixed(0)}%` } })),
      h("span.dw-wx__dt", null, h("span", { text: `${Math.round(d.lo)}°` }), h("span.dw-wx__dhi", { text: `${Math.round(d.hi)}°` })));
  }));
}

// ── W-02 Tasks ────────────────────────────────────────────────────────────
const DOT = { due: "var(--amber)", pending: "var(--accent)", snoozed: "var(--muted)" };

function renderTasks(body, env) {
  if (!tasksOn()) { body.append(empty(t("db.tk.off"))); return { meta: "" }; }
  const open = openTasks(), due = open.filter((x) => x.state === "due").length;
  if (!open.length) body.append(empty(t("db.tk.empty")));
  else body.append(h("div.dw-rows", null, open.slice(0, Math.max(1, env.item.h * 2 - 1)).map((task) =>
    h("button.dw-row.dw-row--task", { vars: { "--dot": DOT[task.state] || "var(--muted)", "--when": task.state === "due" ? "var(--amber)" : "var(--muted)" }, on: { click: () => env.go({ view: "tasks" }) } },
      h("span.dw-row__dot"),
      h("span.dw-row__main", null, h("span.dw-row__t", { text: task.goal }), h("span.dw-row__s", { text: whenText(task, env.now) })),
      h("span.dw-row__tag", { text: levelTag(task) })))));
  return { meta: t("db.tk.meta", { due, up: open.length - due }), tone: due ? "amber" : "muted" };
}

// ── W-04 Deadlines ────────────────────────────────────────────────────────
function renderDeadlines(body, env) {
  if (!tasksOn()) { body.append(empty(t("db.tk.off"))); return { meta: "" }; }
  const { now, rowH, item } = env;
  const all = deadlines(now);
  if (!all.length) { body.append(empty(t("db.dl.empty"))); return { meta: "" }; }
  const n = Math.max(1, Math.floor((rowH * item.h + 12 * (item.h - 1) - 52) / 60));
  const list = all.slice(0, n);
  body.append(h("div.dw-dls", null, list.map((x, i) => {
    const color = x.days <= 7 ? "var(--amber)" : x.days <= 14 ? "var(--accent)" : "var(--muted)";
    const d = new Date(x.at), area = Array.isArray(x.task.owner_domains) && typeof x.task.owner_domains[0] === "string" ? x.task.owner_domains[0] : "";
    const sub = x.at <= now.getTime() ? t("db.dl.overdue", { date: `${dateShort(d)} ${hhmm(d)}` }) : `${wdShort(d)} ${dateShort(d)} ${hhmm(d)}`;
    return h("button.dw-dl", { cls: i === list.length - 1 ? "is-last" : "", vars: { "--c": color, "--p": `${Math.max(4, (1 - Math.min(x.days, 45) / 45) * 100).toFixed(0)}%` }, on: { click: () => env.go({ view: "tasks" }) } },
      h("span.dw-dl__top", null, h("span.dw-dl__t", { text: x.task.goal }), h("span.dw-dl__n", null, String(x.days), h("span", { text: t("db.dl.days") }))),
      h("span.dw-dl__bar", null, h("span")),
      h("span.dw-dl__s", { text: area ? `${sub} · ${area}` : sub }));
  })));
  const next = all.find((x) => x.at > now.getTime()), late = all.length - all.filter((x) => x.at > now.getTime()).length;
  return { meta: next ? t("db.dl.meta", { d: next.days }) : t("db.dl.late", { n: late }), tone: "amber" };
}

// ── W-07 Memory ───────────────────────────────────────────────────────────
let memCache = { graph: null, day: "", v: null };

/** New memories per day over the last 14 days (by `created`), and the last 7. */
export function memoryStats(now) {
  const dayKey = startOfDay(now).toDateString();
  if (memCache.graph === data.graph && memCache.day === dayKey && memCache.v) return memCache.v;
  const days = new Array(14).fill(0), t0 = startOfDay(now).getTime() - 13 * DAY;
  let total = 0;
  for (const n of data.graph?.nodes || []) {
    if (!n || n.kind !== "memory") continue;
    total++;
    const at = typeof n.created === "string" ? Date.parse(`${n.created.slice(0, 10)}T12:00:00`) : NaN;
    if (!Number.isFinite(at) || at < t0) continue;
    const i = Math.floor((at - t0) / DAY);
    if (i >= 0 && i < 14) days[i]++;
  }
  const v = { days, week: days.slice(7).reduce((a, b) => a + b, 0), total: Number.isFinite(data.health?.vault_size) ? data.health.vault_size : total };
  memCache = { graph: data.graph, day: dayKey, v };
  return v;
}

function renderMemory(body, env) {
  const m = memoryStats(env.now), mx = Math.max(1, ...m.days);
  const areas = data.clusters.slice().sort((a, b) => b.count - a.count).slice(0, env.item.h + 1), am = Math.max(1, areas[0]?.count || 1);
  body.append(h("div.dw-mem", null,
    h("div.dw-mem__top", null,
      h("button.dw-mem__total", { on: { click: () => env.go({ view: "mindspace" }) } },
        h("span.dw-mem__n", { text: numberFmt.format(m.total) }), h("span.dw-mem__wk", { text: t("db.m.week", { n: `+${m.week}` }) })),
      h("div.dw-mem__chart", null,
        h("div.dw-mem__bars", null, m.days.map((v, i) => h("span", { title: t("db.m.bar", { n: v }), cls: i === m.days.length - 1 ? "is-today" : "", vars: { "--h": `${Math.max(6, (v / mx) * 100).toFixed(0)}%` } }))),
        h("div.dw-mem__k", null, h("span", { text: t("db.m.days") }), h("span", { text: t("db.m.today") })))),
    env.item.h >= 3 ? h("div.dw-mem__areas", null, areas.map((a) =>
      h("div.dw-mem__area", null, h("span.dw-mem__an", { text: a.key }), h("span.dw-mem__ab", null, h("span", { vars: { "--w": `${((a.count / am) * 100).toFixed(0)}%` } })), h("span.dw-mem__ac", { text: String(a.count) })))) : null));
  return { meta: t("db.m.meta") };
}

export const BUILTIN = [
  { type: "briefing", code: "W-00", titleKey: "db.w.briefing.t", descKey: "db.w.briefing.d", w: 5, h: 3, minW: 4, minH: 2, icon: "M4 5h16v14H4ZM4 9h16M8 13h5M8 16h8", render: renderBriefing },
  { type: "weather", code: "W-01", titleKey: "db.w.weather.t", descKey: "db.w.weather.d", w: 7, h: 3, minW: 3, minH: 2, icon: "M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z", render: renderWeather },
  { type: "tasks", code: "W-02", titleKey: "db.w.tasks.t", descKey: "db.w.tasks.d", w: 4, h: 3, minW: 3, minH: 2, icon: "M4 5h16v15H4ZM4 9h16M8 14l2.5 2.5L16 12", render: renderTasks },
  { type: "deadlines", code: "W-04", titleKey: "db.w.deadlines.t", descKey: "db.w.deadlines.d", w: 4, h: 3, minW: 3, minH: 2, icon: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", render: renderDeadlines },
  { type: "memory", code: "W-07", titleKey: "db.w.memory.t", descKey: "db.w.memory.d", w: 4, h: 3, minW: 3, minH: 2, icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", render: renderMemory },
];
