// Right panel › Signals for the vault views (prototype tabSignals): four
// figure tiles over the real graph plus the SYSTEM block from /ui/health.
//   connections  — edges between two memories on the map
//   unwritten    — ghost nodes (linked, not written yet)
//   bridge nodes — node.bridge (list of the areas it spans; null otherwise)
//   care flags   — open entries of GET /ui/annotations (vault-care.md)
// In the engine views (Mindspace, Clouds, Semantic) a tile filters the map,
// as the old sidebar signals did (state.signal); elsewhere tiles only inform.
import { h, clear } from "../dom.js";
import { t, numberFmt } from "../i18n.js";
import { state, setState } from "../state.js";
import { data } from "../data.js";
import { getArea } from "../areas.js";

let care = null, careAt = 0, careLoading = false; // Set of node ids with an open care flag
let redraw = null; // the open tab, redrawn once the care flags arrive

/** Ids with an open care flag (null until loaded). */
export const careIds = () => care;

const isBridge = (n) => (Array.isArray(n.bridge) ? n.bridge.length > 0 : !!n.bridge);

function loadCare() {
  if (careLoading || (care && Date.now() - careAt < 60000)) return;
  careLoading = true;
  fetch("/ui/annotations", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((b) => {
    const list = Array.isArray(b?.annotations) ? b.annotations : [];
    care = new Set(list.filter((a) => a && !a.done && typeof a.id === "string").map((a) => a.id));
    careAt = Date.now();
    setState({ careN: care.size }); // the engine filter picks it up
    redraw?.();
  }).catch(() => { /* keep last */ }).finally(() => { careLoading = false; });
}

function counts() {
  const g = data.graph;
  if (!g) return null;
  const ids = new Set(), ghosts = [];
  let bridges = 0;
  for (const n of g.nodes) {
    if (!n || typeof n.id !== "string") continue;
    ids.add(n.id);
    if (n.kind === "ghost") ghosts.push(n);
    if (isBridge(n)) bridges++;
  }
  let edges = 0;
  for (const e of g.edges) if (e && ids.has(e.source) && ids.has(e.target)) edges++;
  return { edges, ghosts: ghosts.length, bridges };
}

export function signalsTab(body) {
  loadCare();
  const draw = () => {
    const c = counts();
    const filters = !!getArea(state.view)?.signalFilter;
    const tile = (key, value, labelKey, desc) => {
      const on = filters && key && state.signal === key;
      const kids = [h("span.sg__v", { text: value }), h("span.sg__l", { text: t(labelKey) }), h("span.sg__d", { text: desc })];
      return filters && key
        ? h("button.sg__tile", { type: "button", cls: on ? "is-on" : "", title: t("sg.filterHint"), on: { click: () => { setState({ signal: on ? null : key }); draw(); } } }, kids)
        : h("div.sg__tile", null, kids);
    };
    const nCare = care ? care.size : null;
    const fmt = (n) => (n === null || n === undefined ? "–" : numberFmt.format(n));
    const hl = data.health;
    const sys = (k, v, acc) => (v ? [h("span.sg__k", { text: t(k) }), h("span.sg__sv", { cls: acc ? "is-acc" : "", text: v })] : []);
    clear(body).append(h("div.sg", null,
      h("div.sg__h", { text: t("sg.title") }),
      h("div.sg__grid", null,
        tile(null, fmt(c?.edges), "sg.connections", t("sg.connectionsD")),
        tile("unwritten", fmt(c?.ghosts), "sg.unwritten", t("sg.unwrittenD")),
        tile("bridges", fmt(c?.bridges), "sg.bridges", t("sg.bridgesD")),
        tile("care", fmt(nCare), "sg.care", nCare ? t("sg.careD", { n: nCare }) : nCare === 0 ? t("sg.careNone") : "")),
      h("div.sg__sys-k", { text: t("sg.system") }),
      h("div.sg__sys", null,
        sys("sg.daemon", typeof hl?.version === "string" ? `v${hl.version}` : "", true),
        sys("sg.semantic", typeof hl?.semantic_recall === "string" ? hl.semantic_recall : "", hl?.semantic_recall === "on"),
        sys("sg.embedding", typeof hl?.embedding_mode === "string" ? hl.embedding_mode : "", false),
        sys("sg.vault", typeof hl?.vault_availability?.warning === "string" ? hl.vault_availability.warning : "", false))));
  };
  redraw = () => { if (body.isConnected) draw(); };
  draw();
}

/** Filter predicate for a signal key over engine nodes (null = no filter). */
export function signalMatch(key) {
  if (key === "unwritten") return (n) => n.kind === "ghost";
  if (key === "bridges") return isBridge;
  if (key === "care") { const ids = care; return ids ? (n) => ids.has(n.id) : null; }
  return null;
}
