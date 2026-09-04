/** Telemetry tab (#463): renders the `/ui/telemetry` report — the same series
 *  `bastra logs --stats` prints, as tables and small charts.
 *
 *  Not a canvas view: nothing here has a position, so the tab is a scroll
 *  page laid over the stage. The map keeps whatever view it had and comes
 *  back untouched when the tab closes.
 *
 *  Every section carries its own gap notes: an `unknown` residual, events
 *  that predate a field, runs excluded for a stated reason. The report never
 *  draws through a hole — it names it. */

import { fetchTelemetry } from "../graph-data.js";

const $ = (sel) => document.querySelector(sel);
const DAYS_KEY = "bastra-vault-map-telemetry-days";

// ── tiny DOM helpers ────────────────────────────────────────────
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
const pct = (n, total) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—");
const ms = (n) => (typeof n === "number" ? `${Math.round(n)} ms` : "—");
const shortSession = (id) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** A cell with a proportional bar next to its number. */
function barCell(n, max, mute = false) {
  const w = max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0;
  const i = h("i", { class: mute ? "mute" : null });
  i.style.width = `${w}%`;
  return h("td", { class: "bar" }, h("span", { class: "tv-bar" }, i));
}

function table(headers, rows) {
  return h(
    "table",
    { class: "tv-table" },
    h("thead", null, h("tr", null, headers.map((t) => h("th", null, t)))),
    h("tbody", null, rows),
  );
}
const td = (v, cls) => h("td", { class: cls ?? null }, v);
const note = (text, warn = false) => h("p", { class: `tv-note${warn ? " warn" : ""}` }, text);
const empty = (text) => h("p", { class: "tv-empty" }, text);
const h3 = (text) => h("h3", { class: "tv-h3" }, text);
const section = (title, question, ...body) =>
  h("section", { class: "tv-section" }, h("h2", { class: "section-title" }, title), h("p", { class: "tv-q" }, question), ...body);

// ── charts ──────────────────────────────────────────────────────
const W = 1000;
const H = 150;
const PAD = { l: 44, r: 8, t: 8, b: 22 };

/** Day-axis labels: first, last, and every n-th so they never collide. */
function dayTicks(days, x, bw) {
  const step = Math.max(1, Math.ceil(days.length / 10));
  const out = [];
  days.forEach((d, i) => {
    if (i % step !== 0 && i !== days.length - 1) return;
    out.push(s("text", { class: "tick", x: x(i) + bw / 2, y: H - 6, "text-anchor": "middle" }, d.slice(5)));
  });
  return out;
}

function yAxis(max, unit) {
  const els = [s("line", { class: "axis", x1: PAD.l, y1: PAD.t, x2: PAD.l, y2: H - PAD.b })];
  for (const f of [0, 0.5, 1]) {
    const y = H - PAD.b - f * (H - PAD.t - PAD.b);
    els.push(s("text", { class: "tick", x: PAD.l - 6, y: y + 3, "text-anchor": "end" }, `${fmt(max * f)}${unit}`));
    if (f > 0) els.push(s("line", { class: "axis", x1: PAD.l, y1: y, x2: W - PAD.r, y2: y, "stroke-dasharray": "2 4" }));
  }
  return els;
}

/** Stacked bars: lanes on top of tool payloads, one bar per day. */
function stackedDaily(daily) {
  const svg = s("svg", { class: "tv-chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  const max = Math.max(1, ...daily.map((d) => d.lanes + d.tools));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const bw = innerW / daily.length;
  const x = (i) => PAD.l + i * bw;
  const yOf = (v) => innerH * (v / max);
  yAxis(max, "").forEach((e) => svg.append(e));
  daily.forEach((d, i) => {
    const tools = yOf(d.tools);
    const lanes = yOf(d.lanes);
    const base = H - PAD.b;
    const g = s("g", null);
    g.append(s("title", null, `${d.day}: lanes ${fmt(d.lanes)} · tool payloads ${fmt(d.tools)} · ${d.sessions} sessions${d.unknown ? ` · ${d.unknown} unknown` : ""}`));
    g.append(s("rect", { class: "tools", x: x(i) + bw * 0.15, y: base - tools, width: bw * 0.7, height: tools }));
    g.append(s("rect", { class: "lanes", x: x(i) + bw * 0.15, y: base - tools - lanes, width: bw * 0.7, height: lanes }));
    svg.append(g);
  });
  dayTicks(daily.map((d) => d.day), x, bw).forEach((e) => svg.append(e));
  return svg;
}

/** Latency per day: hook median as bars, hook p95 as a mark, recall median as a thin bar. */
function latencyDaily(daily) {
  const svg = s("svg", { class: "tv-chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  const max = Math.max(1, ...daily.map((d) => Math.max(d.hook?.p95 ?? 0, d.recall?.median ?? 0)));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const bw = innerW / daily.length;
  const x = (i) => PAD.l + i * bw;
  const yOf = (v) => innerH * (v / max);
  const base = H - PAD.b;
  yAxis(max, "").forEach((e) => svg.append(e));
  daily.forEach((d, i) => {
    const g = s("g", null);
    g.append(s("title", null, `${d.day}: hook median ${ms(d.hook?.median)} · p95 ${ms(d.hook?.p95)} (n=${d.hook?.n ?? 0}) · recall median ${ms(d.recall?.median)} (n=${d.recall?.n ?? 0})`));
    if (d.hook) {
      g.append(s("rect", { class: "lanes", x: x(i) + bw * 0.12, y: base - yOf(d.hook.median), width: bw * 0.42, height: yOf(d.hook.median) }));
      const yp = base - yOf(d.hook.p95);
      g.append(s("line", { class: "p95", x1: x(i) + bw * 0.12, y1: yp, x2: x(i) + bw * 0.54, y2: yp }));
    }
    if (d.recall) {
      g.append(s("rect", { class: "recall", x: x(i) + bw * 0.6, y: base - yOf(d.recall.median), width: bw * 0.28, height: yOf(d.recall.median) }));
    }
    svg.append(g);
  });
  dayTicks(daily.map((d) => d.day), x, bw).forEach((e) => svg.append(e));
  return svg;
}

// ── sections ────────────────────────────────────────────────────
function renderOverview(r) {
  const q = r.quality;
  const loaded = q.bands.reduce((n, b) => n + b.loaded, 0);
  const acted = q.bands.reduce((n, b) => n + b.acted, 0);
  const ev = r.evidence;
  const gate = !ev ? "no decisions" : ev.live.calls > 0 ? "live" : "shadow";
  const fig = (k, v, sub, ok = false) =>
    h("div", null, h("div", { class: "tv-fig-k" }, k), h("div", { class: `tv-fig-v${ok ? " ok" : ""}` }, v), sub ? h("div", { class: "tv-fig-sub" }, sub) : null);
  return h(
    "div",
    { id: "tv-overview" },
    fig("events", fmt(r.window.events), `${r.window.files} day file${r.window.files === 1 ? "" : "s"}`),
    fig("context tokens", fmt(r.contextTax.totalTokens), r.contextTax.totalUnknown > 0 ? `lower bound · ${fmt(r.contextTax.totalUnknown)} unknown` : `${fmt(r.contextTax.emissions)} emissions · ${r.contextTax.estimator}`),
    fig("hook calls", fmt(q.hookCalls.calls), `${pct(q.hookCalls.withHints, q.hookCalls.calls)} with hints`),
    fig("loads from a hint", pct(q.followThrough.fromHint, q.followThrough.loads), `${fmt(q.followThrough.fromHint)} of ${fmt(q.followThrough.loads)} loads`),
    fig("use-rate", pct(acted, loaded), `acted on / loaded (${fmt(loaded)} loaded)`, acted > 0),
    fig("evidence gate", gate, ev ? `${fmt(ev.shadow.decisions + ev.live.decisions)} decisions` : "—", gate === "live"),
  );
}

function renderQuality(q, t) {
  const bands = q.bands;
  const maxS = Math.max(1, ...bands.map((b) => b.surfaced));
  const bandRows = bands.map((b) =>
    h("tr", null, td(b.band), barCell(b.surfaced, maxS), td(fmt(b.surfaced)), td(fmt(b.loaded)), td(pct(b.loaded, b.surfaced), "dim"), td(fmt(b.acted)), td(pct(b.acted, b.loaded), b.acted > 0 ? "ok" : null)),
  );
  const srcRows = q.bySource.map((x) =>
    h("tr", null, td(x.source), td(fmt(x.surfaced)), td(fmt(x.loaded)), td(pct(x.loaded, x.surfaced), "dim"), td(fmt(x.acted)), td(pct(x.acted, x.loaded), x.acted > 0 ? "ok" : null)),
  );
  const ft = q.followThrough;
  const maxR = Math.max(1, ...ft.ranks.map((x) => x.count));
  const rankRows = ft.ranks.map((x) => h("tr", null, td(`rank ${x.rank}`), barCell(x.count, maxR), td(fmt(x.count)), td(pct(x.count, ft.fromHint), "dim")));
  const ts = q.hookCalls.topScore;
  const tsTotal = ts.required + ts.optional + ts.below_floor;
  const tsRows = [
    ["≥ " + t.mustLoadScore + " (required)", ts.required],
    [`${t.scoreFloor}–${t.mustLoadScore - 1} (optional)`, ts.optional],
    ["< " + t.scoreFloor + " (below floor)", ts.below_floor],
  ].map(([k, v]) => h("tr", null, td(k), barCell(v, Math.max(1, tsTotal)), td(fmt(v)), td(pct(v, tsTotal), "dim")));

  return section(
    "Recall quality",
    "Do the hints the hooks surface get loaded, and do loaded hints change the next tool input?",
    h(
      "div",
      { class: "tv-cols" },
      h(
        "div",
        null,
        h3("Hit bands — surfaced → loaded → acted on"),
        bands.some((b) => b.surfaced + b.loaded > 0)
          ? table(["band", "", "surfaced", "loaded", "loaded/surf.", "acted", "use-rate"], bandRows)
          : empty("no hook recalls with hits in this window"),
        note("Use-rate is acted on / loaded — the honest rate. Acted on / surfaced is diluted by repeat surfacing of the same hint."),
        q.directLoads > 0 ? note(`${fmt(q.directLoads)} direct load(s) without a preceding hint are excluded from every band quota (#77).`) : null,
        h3("By hint source"),
        table(["source", "surfaced", "loaded", "loaded/surf.", "acted", "use-rate"], srcRows),
      ),
      h(
        "div",
        null,
        h3("Follow-through — hint → load_memory"),
        table(
          ["", "count"],
          [
            h("tr", null, td("load_memory total"), td(fmt(ft.loads))),
            h("tr", null, td("triggered by a hint"), td(`${fmt(ft.fromHint)} (${pct(ft.fromHint, ft.loads)})`)),
            h("tr", null, td("hook recalls with hits"), td(fmt(ft.hookRecallsWithHits))),
            h("tr", null, td("…that led to a load"), td(`${fmt(ft.hookRecallsConsumed)} (${pct(ft.hookRecallsConsumed, ft.hookRecallsWithHits)})`)),
          ],
        ),
        h3("Rank of the loaded hint"),
        rankRows.length ? table(["rank", "", "loads", "share"], rankRows) : empty("no hint-triggered loads in this window"),
        h3("Top score per hook call (pre-dedup)"),
        table(["band", "", "calls", "share"], tsRows),
        ts.none > 0 ? note(`${fmt(ts.none)} call(s) had no candidate at all (daemon unreachable or empty query).`) : null,
      ),
    ),
  );
}

function renderContextTax(c) {
  const ledgerRows = (rows) => {
    const max = Math.max(1, ...rows.map((r) => r.tokens));
    return rows
      .filter((r) => r.emissions > 0)
      .map((r) => h("tr", null, td(r.kind), barCell(r.tokens, max), td(fmt(r.tokens)), td(fmt(r.emissions), "dim"), td(r.unknown ? fmt(r.unknown) : "", "dim")));
  };
  const laneSum = c.lanes.reduce((n, r) => n + r.tokens, 0);
  const toolSum = c.tools.reduce((n, r) => n + r.tokens, 0);
  const presRows = ledgerRows(c.loadByPresentation);
  const a = c.archival;
  const candRows = a.candidates.map((x) => h("tr", null, td(fmt(x.emitted) + "×"), td(x.type, "dim"), td(x.id, "id")));
  const dirRows = a.directives.map((x) => h("tr", null, td(fmt(x.emitted) + "×"), td(x.type, "dim"), td(x.id, "id")));

  return section(
    "Context tax",
    "How many tokens does recall write into the transcript — hook injections and tool payloads together?",
    h("div", { class: "tv-legend" }, h("span", null, "hook lanes"), h("span", { class: "tools" }, "tool payloads (recall · load_memory · read_document)")),
    c.daily.length ? stackedDaily(c.daily) : empty("no emissions in this window"),
    note(`Estimator ${c.estimator} everywhere, so hook and payload sizes sit in the same column. Total ${fmt(c.totalTokens)} tokens = lanes ${fmt(laneSum)} + payloads ${fmt(toolSum)}.`),
    c.totalUnknown > 0
      ? note(`${fmt(c.totalUnknown)} emission(s) carry no size field (rows before #457/#72) and count as unknown, never as zero — the total is a lower bound.`, true)
      : null,
    h(
      "div",
      { class: "tv-cols" },
      h(
        "div",
        null,
        h3("By hook lane"),
        table(["lane", "", "tokens", "emissions", "unknown"], ledgerRows(c.lanes)),
        h3("By tool payload"),
        table(["tool", "", "tokens", "emissions", "unknown"], ledgerRows(c.tools)),
        presRows.length ? h3("load_memory by presentation") : null,
        presRows.length ? table(["presentation", "", "tokens", "loads", "unknown"], presRows) : null,
      ),
      h(
        "div",
        null,
        h3("Top sessions by total context"),
        c.topSessions.length
          ? table(["session", "tokens", "emissions"], c.topSessions.map((x) => h("tr", null, td(shortSession(x.session), "dim"), td(fmt(x.tokens)), td(fmt(x.emissions), "dim"))))
          : empty("no attributable sessions"),
        note("Tool payloads are attributed to the caller session where the forwarder sent one; hook lanes to their own session id."),
        h3("Archival candidates — emitted ≥3×, never acted on"),
        candRows.length ? table(["emitted", "type", "memory"], candRows) : empty("none in this window"),
        a.unknownTyped > 0
          ? note(`${a.unknownTyped} of these come from events before hinted_types existed (#354) — type unverified, kept in this list but not evidence.`, true)
          : null,
        h3(`Directive-type memories with acted_on 0 — NOT candidates (${a.directives.length})`),
        note("A rule that works produces no acted_on signal: it works by nothing happening. This list is not evidence of waste."),
        dirRows.length ? table(["emitted", "type", "memory"], dirRows) : empty("none in this window"),
        a.untypedEmissions > 0
          ? note(`Type coverage: ${fmt(a.typedEmissions)} hinting emission(s) carry hinted_types, ${fmt(a.untypedEmissions)} predate the field.`)
          : null,
      ),
    ),
  );
}

/** Two bars per day: what the lanes emitted, and the part a session budget would have cut. */
function budgetDaily(daily) {
  const svg = s("svg", { class: "tv-chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  const max = Math.max(1, ...daily.map((d) => d.tokens));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const bw = innerW / daily.length;
  const x = (i) => PAD.l + i * bw;
  const yOf = (v) => innerH * (v / max);
  const base = H - PAD.b;
  yAxis(max, "").forEach((e) => svg.append(e));
  daily.forEach((d, i) => {
    const g = s("g", null);
    g.append(s("title", null, `${d.day}: emitted ${fmt(d.tokens)} · would be trimmed ${fmt(d.tokensTrimmed)} in ${d.wouldDrop} emission(s) · ${d.sessionsAffected} session(s) affected`));
    g.append(s("rect", { class: "tools", x: x(i) + bw * 0.15, y: base - yOf(d.tokens), width: bw * 0.7, height: yOf(d.tokens) }));
    g.append(s("rect", { class: "lanes", x: x(i) + bw * 0.15, y: base - yOf(d.tokensTrimmed), width: bw * 0.7, height: yOf(d.tokensTrimmed) }));
    svg.append(g);
  });
  dayTicks(daily.map((d) => d.day), x, bw).forEach((e) => svg.append(e));
  return svg;
}

function renderBudgetShadow(b) {
  const title = "Context budget — shadow";
  const question = "What would one cumulative budget per session, across all six lanes, have trimmed? Nothing is trimmed yet — the decision is only logged.";
  if (!b) {
    return section(title, question, empty("no budget_shadow events in this window — the shadow ledger records from the first lane call after the daemon that carries it"));
  }
  const maxT = Math.max(1, ...b.byLane.map((r) => r.tokens));
  const rows = b.byLane.map((r) =>
    h("tr", null, td(r.lane), barCell(r.tokensTrimmed, maxT), td(fmt(r.tokens)), td(fmt(r.emissions), "dim"), td(fmt(r.wouldDrop), r.wouldDrop > 0 ? null : "dim"), td(fmt(r.tokensTrimmed), r.tokensTrimmed > 0 ? "ok" : "dim"), td(pct(r.tokensTrimmed, r.tokens), "dim")),
  );
  return section(
    title,
    question,
    h("div", { class: "tv-verdict" }, `shadow budget ${fmt(b.budget)} tokens per session · ${fmt(b.sessionsAffected)} of ${fmt(b.sessions)} session(s) would have been touched · ${fmt(b.tokensTrimmed)} of ${fmt(b.tokens)} tokens (${pct(b.tokensTrimmed, b.tokens)}) would not have been injected`),
    h("div", { class: "tv-legend" }, h("span", { class: "tools" }, "emitted by the lanes"), h("span", null, "would have been trimmed")),
    b.daily.length ? budgetDaily(b.daily) : null,
    h3("By lane"),
    table(["lane", "", "tokens", "emissions", "would drop", "tokens trimmed", "share"], rows),
    b.firstOverAtEmission !== null ? note(`In affected sessions the budget was first exceeded at emission ${fmt(b.firstOverAtEmission)} (median).`) : null,
    b.budgets.length > 1 ? note(`The budget changed inside this window (${b.budgets.map(fmt).join(" → ")} tokens) — rows before the change were decided against the older value.`, true) : null,
    note("Granularity is one decision per emission, like the what-if in stats.ts: a block that no longer fits falls whole. The live governor will decide per entry, so this is an upper bound on what a budget touches."),
    note("The ledger lives in the daemon's memory and counts from the first lane call; a daemon restart starts every running session at zero. `clear` resets a session, `compact` and `resume` do not."),
  );
}

function renderLatency(l) {
  const max = Math.max(1, ...l.lanes.map((r) => r.p95));
  const rows = l.lanes.map((r) => h("tr", null, td(r.lane), barCell(r.median, max), td(ms(r.median)), td(ms(r.p95), "dim"), td(fmt(r.n), "dim")));
  return section(
    "Latency",
    "How long do the hook lanes and the daemon's recall take — median and p95, over time?",
    h("div", { class: "tv-legend" }, h("span", null, "hook lanes · median"), h("span", { class: "p95" }, "hook lanes · p95"), h("span", { class: "recall" }, "daemon recall · median")),
    l.daily.length ? latencyDaily(l.daily) : empty("no latency fields in this window"),
    h3("By lane"),
    rows.length ? table(["lane", "", "median", "p95", "n"], rows) : empty("no latency fields in this window"),
    note("hook_call / *_hook_call measure the whole hook process (latency_ms_total); hook_recall and recall measure the daemon's search alone."),
  );
}

function renderEvidence(ev) {
  if (!ev) {
    return section("Evidence gate", "Is the deterministic decision (§10.3) accepted, and where does it diverge from legacy banding?", empty("no evidence_decision events in this window"));
  }
  const acc = ev.acceptance;
  const cr = ev.criteria;
  const crit = (label, v, target, ok, text) => {
    const i = h("i", { class: ok ? null : "mute" });
    i.style.width = `${target > 0 ? Math.min(100, (v / target) * 100) : 0}%`;
    return h("li", null, h("span", null, label), h("span", { class: "tv-bar" }, i), h("span", { class: `v${ok ? " ok" : ""}` }, text));
  };
  const shareOk = acc.topSessionShare <= cr.maxSessionShare;
  const verdict = acc.route
    ? `shadow acceptance REACHED via the ${acc.route} route — divergence review below is the remaining condition`
    : `shadow acceptance not yet — ${acc.missing.join(", ")}; or ${acc.days}/${cr.minDays} days`;
  const mixTotal = ev.decisions.reduce((n, d) => n + d.count, 0);
  const mixRows = ev.decisions.map((d) => h("tr", null, td(d.decision), barCell(d.count, Math.max(1, mixTotal)), td(fmt(d.count)), td(pct(d.count, mixTotal), "dim")));
  const dv = ev.divergence;
  const dvTotal = dv.agree + dv.withholds + dv.promotes;
  const viaHop = ev.requiredByHop.find((x) => x.hop === "1-hop")?.count ?? 0;

  return section(
    "Evidence gate",
    "Is the deterministic decision (§10.3) accepted, and where does it diverge from legacy banding?",
    h("div", { class: `tv-verdict${acc.route ? " ok" : ""}` }, verdict),
    h(
      "div",
      { class: "tv-cols" },
      h(
        "div",
        null,
        h3("Shadow acceptance — §18.2 / C-085"),
        h(
          "ul",
          { class: "tv-list" },
          crit("decisions", acc.decisions, cr.minDecisions, acc.decisions >= cr.minDecisions, `${fmt(acc.decisions)} / ${cr.minDecisions}`),
          crit("sessions", acc.sessions, cr.minSessions, acc.sessions >= cr.minSessions, `${fmt(acc.sessions)} / ${cr.minSessions}`),
          crit("largest session share", acc.topSessionShare, cr.maxSessionShare, shareOk, `${(acc.topSessionShare * 100).toFixed(1)} % ≤ ${cr.maxSessionShare * 100} %`),
          crit("calendar days (own route)", acc.days, cr.minDays, acc.days >= cr.minDays, `${acc.days} / ${cr.minDays}`),
        ),
        note(`${fmt(ev.shadow.calls)} shadow call(s) with ${fmt(ev.shadow.decisions)} decisions over ${ev.shadow.days} day(s); ${fmt(ev.live.calls)} live call(s) with ${fmt(ev.live.decisions)} decisions${ev.live.calls > 0 ? " — the gate is ACTIVE" : ""}.`),
        ev.excluded.degraded + ev.excluded.failed > 0
          ? note(`Excluded: ${fmt(ev.excluded.degraded)} degraded run(s) — a budget abort is not an abstention (C-047); ${fmt(ev.excluded.failed)} failed decision(s) — a controller defect enters neither statistic (C-052).`, true)
          : null,
      ),
      h(
        "div",
        null,
        h3("Decision mix (shadow + live)"),
        table(["decision", "", "count", "share"], mixRows),
        ev.abstainReasons.length ? note(`abstain reasons: ${ev.abstainReasons.map((r) => `${r.reason} ${fmt(r.count)}`).join(" · ")}`) : null,
        ev.requiredByHop.length ? note(`required by hop origin: ${ev.requiredByHop.map((r) => `${r.hop} ${fmt(r.count)}`).join(" · ")}`) : null,
        viaHop > 0 ? note(`${viaHop} required hit(s) came via a graph hop — C-046 forbids that; check the predicate.`, true) : null,
        h3("Divergence vs legacy — required (fused runs only)"),
        dvTotal > 0
          ? table(
              ["", "decisions", "share"],
              [
                h("tr", null, td("agree"), td(fmt(dv.agree)), td(pct(dv.agree, dvTotal), "dim")),
                h("tr", null, td("legacy required, gate not — the gate withholds"), td(fmt(dv.withholds)), td(pct(dv.withholds, dvTotal), "dim")),
                h("tr", null, td("gate required, legacy not — the gate promotes"), td(fmt(dv.promotes)), td(pct(dv.promotes, dvTotal), "dim")),
              ],
            )
          : empty("no comparable decisions"),
        note("On the BM25 fallback the score is unbounded and the 30/100 cuts describe nothing (§9.4), so unfused runs are not compared."),
        dv.unfused + dv.unknownSpace > 0
          ? note(`${fmt(dv.unfused)} decision(s) on unfused runs skipped; ${fmt(dv.unknownSpace)} with no hook_recall in this window (score space unknown).`)
          : null,
      ),
    ),
  );
}

function renderSessionStart(ss) {
  const rows = ss.parts.map((p) =>
    h("tr", null, td(p.part), barCell(p.tokens, Math.max(1, ss.totalTokens)), td(fmt(p.tokens)), td(pct(p.tokens, ss.totalTokens), "dim"), td(fmt(p.avgPerStart)), td(`${p.presentIn}/${ss.withParts}`, "dim")),
  );
  const srcRows = ss.bySource.map((x) => h("tr", null, td(x.source), td(fmt(x.n), "dim"), h("td", { class: "id dim left" }, x.parts.slice(0, 5).map((p) => `${p.part} ${fmt(p.avg)}`).join(" · "))));
  return section(
    "Session start",
    "What does the session-start block cost, and which of its parts spends the tokens?",
    ss.starts === 0
      ? empty("no session starts in this window")
      : h(
          "div",
          { class: "tv-cols" },
          h(
            "div",
            null,
            h3(`Tokens by part — ${fmt(ss.withParts)} start(s) with per-part data, ${fmt(ss.totalTokens)} tokens`),
            rows.length ? table(["part", "", "tokens", "share", "avg / start", "present in"], rows) : empty("no start carries hint_tokens_by_part yet"),
            ss.withoutParts > 0
              ? note(`${fmt(ss.withoutParts)} of ${fmt(ss.starts)} start(s) predate hint_tokens_by_part (#462) — they carry a total only and are not in the shares above.`, true)
              : null,
          ),
          h(
            "div",
            null,
            h3("Average tokens per part, by start source"),
            srcRows.length ? table(["source", "starts", "top parts (avg tokens)"], srcRows) : empty("—"),
            note("The same block is assembled on startup, clear, compact and resume — a part that repeats identically across sources is a cadence question, not a content one."),
          ),
        ),
  );
}

// ── the manager ─────────────────────────────────────────────────
export function createTelemetryView() {
  const root = $("#telemetry-view");
  const body = $("#tv-body");
  const status = $("#tv-status");
  const windowNote = $("#tv-window-note");
  const seg = $("#tv-window");
  let days = Number(localStorage.getItem(DAYS_KEY)) || 7;
  let open = false;
  let loading = null;

  function markDays() {
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", Number(b.dataset.days) === days));
  }

  async function load() {
    if (loading) return loading;
    status.hidden = false;
    status.classList.remove("err");
    status.textContent = `reading the last ${days} day(s) of event logs…`;
    loading = (async () => {
      try {
        const r = await fetchTelemetry(days);
        body.replaceChildren(
          renderOverview(r),
          renderQuality(r.quality, r.thresholds),
          renderContextTax(r.contextTax),
          renderBudgetShadow(r.budgetShadow),
          renderLatency(r.latency),
          renderEvidence(r.evidence),
          renderSessionStart(r.sessionStart),
        );
        const span = r.window.from && r.window.to ? `${r.window.from.slice(0, 10)} → ${r.window.to.slice(0, 10)}` : "no events";
        windowNote.textContent = `${span} · ${fmt(r.window.events)} events · retention keeps ${r.window.retentionDays} days`;
        if (r.window.days < days) {
          days = r.window.days;
          markDays();
        }
        status.hidden = true;
      } catch (err) {
        status.classList.add("err");
        status.textContent = `could not load the telemetry report — ${err.message}`;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  seg.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-days]");
    if (!b || loading) return;
    days = Number(b.dataset.days);
    localStorage.setItem(DAYS_KEY, String(days));
    markDays();
    void load();
  });
  markDays();

  return {
    isOpen: () => open,
    open() {
      if (open) return;
      open = true;
      root.hidden = false;
      document.body.classList.add("telemetry-open");
      void load();
    },
    close() {
      open = false;
      root.hidden = true;
      document.body.classList.remove("telemetry-open");
    },
    /** For the demo runner / tests: re-fetch the current window. */
    refresh: () => load(),
  };
}
