// Vault data for the vault views, built from GET /api/v1/graph (data.graph).
// The prototype's sample vault (memory-data.js) is replaced by real nodes:
//   area     = node.cluster            recalled = node.reach.loaded
//   at       = node.updated (date)     acted    = node.reach.acted_on
//   links    = edges (related | related_via)
//   created  = node.created (date, only when the frontmatter holds a valid ISO date)
import { data } from "../data.js";
import { state } from "../state.js";
import { range } from "../timeline.js";

const DAY = 864e5, WEEK = 7 * DAY;

/** Real memory types → the prototype's six display classes (colours TC). */
const CLASS = {
  decision: "decision",
  lesson: "rule",
  rule: "rule",
  preference: "convention",
  "user-preference": "convention",
  workflow: "convention",
  convention: "convention",
  "project-fact": "fact",
  fact: "fact",
  "meta-working": "note",
  note: "note",
  reference: "reference",
  bookmark: "reference",
  doc: "reference",
};
export const typeClass = (type) => CLASS[type] || "note";

/** Edge kinds → relation keys used by the lenses (RC colours). */
export const REL = { related: "linked", related_via: "derived" };

export function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }

const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (Number.isFinite(v) ? v : 0);

let built = null, builtFor = null;

/**
 * { mems, byId, areas: [{ key, count, meta }], ghosts, total, linksOf(area) }
 * mems: { id, area, title, type, kind, cls, at, created, recalled, acted, links: [{ id, rel }] }
 */
export function vault() {
  const g = data.graph;
  if (!g) return null;
  if (builtFor === g) return built;
  const mems = [], ghosts = [], byId = new Map(), metaKeys = new Set();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.cluster !== "string") continue;
    if (n.kind === "ghost") { ghosts.push({ id: n.id, area: n.cluster }); continue; }
    if (n.kind !== "memory" && n.kind !== "doc") continue;
    const at = Date.parse(str(n.updated));
    const created = Date.parse(str(n.created));
    const m = { id: n.id, area: n.cluster, title: str(n.title) || n.id, type: str(n.type), kind: n.kind, cls: typeClass(n.kind === "doc" ? "doc" : str(n.type)),
      summary: str(n.summary), at: Number.isFinite(at) ? at : NaN, created: Number.isFinite(created) ? created : NaN,
      recalled: num(n.reach?.loaded), acted: num(n.reach?.acted_on), links: [] };
    mems.push(m); byId.set(m.id, m);
    if (n.group === "rules") metaKeys.add(n.cluster);
  }
  for (const e of g.edges) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b || a === b) continue;
    a.links.push({ id: b.id, rel: REL[e.via] || "derived" });
  }
  const counts = new Map();
  for (const m of mems) counts.set(m.area, (counts.get(m.area) || 0) + 1);
  // Order follows GET /api/v1/graph clusters (same order as the Areas list and its colours).
  const order = new Map(data.clusters.map((c, i) => [c.key, i]));
  const areas = [...counts.entries()].map(([key, count]) => ({ key, count, meta: metaKeys.has(key) }))
    .sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9) || b.count - a.count);
  const areaLinks = new Map();
  for (const m of mems) for (const l of m.links) {
    const o = byId.get(l.id);
    areaLinks.set(m.area, (areaLinks.get(m.area) || 0) + 1);
    if (o.area !== m.area) areaLinks.set(o.area, (areaLinks.get(o.area) || 0) + 1);
  }
  built = { mems, byId, areas, ghosts, total: mems.length, linksOf: (k) => areaLinks.get(k) || 0 };
  builtFor = g;
  return built;
}

/** Footer time range as [from, to) in ms, or null for "all" (state.time / state.brush). */
export function timeWindow() {
  if (!data.weekStart) return null;
  const [a, b] = range();
  if (a <= 0 && b >= 52) return null;
  const s = data.weekStart.getTime();
  return [s + a * WEEK, s + b * WEEK];
}

export function inWindow(m, win) { return !win || (Number.isFinite(m.at) && m.at >= win[0] && m.at < win[1]); }

/** Key that changes whenever the footer range changes. */
export const windowKey = () => `${state.brush ? state.brush.a + "-" + state.brush.b : state.time}`;

/** Area colour, same hue rule as the Areas list (lens.color) with alpha. */
export function areaCol(key, a = 1) {
  const i = data.clusters.findIndex((c) => c.key === key);
  return i < 0 ? `rgba(160,180,205,${a})` : `hsla(${((i * 137.508 + 205) % 360).toFixed(1)}, 78%, 66%, ${a})`;
}

/** Most recently updated memories of an area. */
export function recentIn(area, n) {
  const v = vault(); if (!v) return [];
  return v.mems.filter((m) => m.area === area).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, n);
}

/** "2m" · "5h" · "3d" · "2w" · "4mo" — prototype ago(). */
export function ago(ms) {
  const min = Math.max(1, (Date.now() - ms) / 60000);
  return min < 60 ? `${Math.round(min)}m` : min < 1440 ? `${Math.round(min / 60)}h` : min < 10080 ? `${Math.round(min / 1440)}d` : min < 43200 ? `${Math.round(min / 10080)}w` : `${Math.round(min / 43200)}mo`;
}
