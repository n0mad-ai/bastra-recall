// Telemetry area — turns the daemon's /ui/telemetry report into section specs
// (title, question, figures, chart, tables, notes) that telemetry-render.js
// draws. Same sections, tables and gap notes as the old Telemetry tab
// (webui/js/managers/telemetry-view.js, telemetry-view-code.js); wording in
// js/i18n/telemetry-*.js. The report is external input: every list and number
// is read defensively.
import { t, LANG } from "../i18n.js";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : []);
export const dec = (s) => (LANG === "de" ? s.replace(".", ",") : s);
/** Prototype number format: thousands grouped with a space ("18 342"). */
export const fmt = (n) =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US").replace(/,/g, " ") : "—";
export const pct = (a, b) => (b > 0 ? `${dec(((a / b) * 100).toFixed(1))}%` : "—");
const ms = (v) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)} ms` : "—");
/** #665: n/a when nothing was measured, one decimal under 10 ms. */
const lat = (v) =>
  typeof v !== "number" || !Number.isFinite(v)
    ? t("tv.na")
    : v < 10
      ? `${dec(v.toFixed(1))} ms`
      : `${Math.round(v)} ms`;
const short = (id) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
/** Plural pick: key + ".1" for exactly one, if that key exists. */
const tn = (key, n, vars) => {
  const one = t(`${key}.1`, vars);
  return n === 1 && one !== `${key}.1` ? one : t(key, vars);
};

// ── table / block specs ──────────────────────────────────────────────────
// head: label | "" (bar column) | { t, kind } with kind label|bar|id|text|tag|num.
// cell: string | { t, dim, ok, warn, mono } | { bar: value, max?, mute? }.
function tbl(h3, head, rows, opts = {}) {
  if (!rows.length && opts.empty) return { kind: "empty", h3, empty: opts.empty, notes: clean(opts.notes) };
  const kinds = head.map((x, i) => (typeof x === "object" ? x.kind : x === "" ? "bar" : i === 0 ? "label" : "num"));
  return {
    kind: "table",
    h3,
    kinds,
    head: head.map((x) => (typeof x === "object" ? x.t : x)),
    rows,
    notes: clean(opts.notes),
    minW: opts.minW || "",
  };
}
const empty = (h3, text, notes) => ({ kind: "empty", h3, empty: text, notes: clean(notes) });
const notesOnly = (h3, notes) => ({ kind: "notes", h3, notes: clean(notes) });
const note = (text, warn = false) => (text ? { t: text, warn } : null);
const clean = (list) => arr(list).filter(Boolean);
const fig = (k, v, sub = "", ok = false) => ({ k, v, sub, ok });

// ── overview ─────────────────────────────────────────────────────────────
function gateOf(ev) {
  return !ev ? t("tv.ov.noDecisions") : num(ev.live?.calls) > 0 ? "live" : "shadow";
}

function overview(r) {
  const q = r.quality || {},
    c = r.contextTax || {},
    w = r.window || {},
    ev = r.evidence;
  const bands = arr(q.bands);
  const loaded = bands.reduce((n, b) => n + num(b.loaded), 0),
    acted = bands.reduce((n, b) => n + num(b.acted), 0);
  const hc = q.hookCalls || {},
    ft = q.followThrough || {};
  const gate = gateOf(ev);
  return [
    fig(t("tv.ov.events"), fmt(num(w.events)), tn("tv.ov.files", num(w.files), { n: fmt(num(w.files)) })),
    fig(
      t("tv.ov.ctx"),
      fmt(num(c.totalTokens)),
      num(c.totalUnknown) > 0
        ? t("tv.ov.ctxLower", { n: fmt(c.totalUnknown) })
        : t("tv.ov.ctxSub", { n: fmt(num(c.emissions)), e: c.estimator || "" })
    ),
    fig(t("tv.ov.hooks"), fmt(num(hc.calls)), t("tv.ov.hooksSub", { p: pct(num(hc.withHints), num(hc.calls)) })),
    fig(
      t("tv.ov.loads"),
      pct(num(ft.fromHint), num(ft.loads)),
      t("tv.ov.loadsSub", { a: fmt(num(ft.fromHint)), b: fmt(num(ft.loads)) })
    ),
    fig(t("tv.ov.use"), pct(acted, loaded), t("tv.ov.useSub", { n: fmt(loaded) }), acted > 0),
    fig(
      t("tv.ov.gate"),
      gate,
      ev ? t("tv.ov.gateSub", { n: fmt(num(ev.shadow?.decisions) + num(ev.live?.decisions)) }) : "—",
      gate === "live"
    ),
  ];
}

// ── 01 recall quality ────────────────────────────────────────────────────
function quality(q, th) {
  q = q || {};
  const bands = arr(q.bands),
    ft = q.followThrough || {},
    ts = q.hookCalls?.topScore || {};
  const loaded = bands.reduce((n, b) => n + num(b.loaded), 0),
    acted = bands.reduce((n, b) => n + num(b.acted), 0);
  const tsTotal = num(ts.required) + num(ts.optional) + num(ts.below_floor);
  const must = num(th?.mustLoadScore),
    floor = num(th?.scoreFloor);
  const H = (k) => t(`tv.col.${k}`);
  return {
    id: "quality",
    title: t("tv.s.quality"),
    q: t("tv.q.quality"),
    key: pct(acted, loaded),
    keyLabel: t("tv.k.useRate"),
    cols: [
      [
        bands.some((b) => num(b.candidates) + num(b.loaded) > 0)
          ? tbl(
              t("tv.h.bands"),
              [H("band"), "", H("candidates"), H("loaded"), H("loadLower"), H("acted"), H("useRate")],
              bands.map((b) => [
                String(b.band ?? ""),
                { bar: num(b.candidates) },
                fmt(num(b.candidates)),
                fmt(num(b.loaded)),
                { t: pct(num(b.loaded), num(b.candidates)), dim: 1 },
                fmt(num(b.acted)),
                { t: pct(num(b.acted), num(b.loaded)), ok: num(b.acted) > 0 },
              ]),
              {
                minW: "520px",
                notes: [
                  note(t("tv.n.bands")),
                  num(q.directLoads) > 0 ? note(t("tv.n.directLoads", { n: fmt(q.directLoads) })) : null,
                ],
              }
            )
          : empty(t("tv.h.bands"), t("tv.e.bands"), [note(t("tv.n.bands"))]),
        tbl(
          t("tv.h.bySource"),
          [H("source"), H("candidates"), H("loaded"), H("loadLower"), H("acted"), H("useRate")],
          arr(q.bySource).map((x) => [
            String(x.source ?? ""),
            fmt(num(x.candidates)),
            fmt(num(x.loaded)),
            { t: pct(num(x.loaded), num(x.candidates)), dim: 1 },
            fmt(num(x.acted)),
            { t: pct(num(x.acted), num(x.loaded)), ok: num(x.acted) > 0 },
          ]),
          { minW: "420px", empty: "—" }
        ),
      ],
      [
        tbl(
          t("tv.h.follow"),
          ["", H("count")],
          [
            [t("tv.r.loadTotal"), fmt(num(ft.loads))],
            [t("tv.r.byHint"), `${fmt(num(ft.fromHint))} (${pct(num(ft.fromHint), num(ft.loads))})`],
            [t("tv.r.withHits"), fmt(num(ft.hookRecallsWithHits))],
            [
              t("tv.r.ledToLoad"),
              `${fmt(num(ft.hookRecallsConsumed))} (${pct(num(ft.hookRecallsConsumed), num(ft.hookRecallsWithHits))})`,
            ],
          ]
        ),
        tbl(
          t("tv.h.rank"),
          [H("rank"), "", H("loads"), H("share")],
          arr(ft.ranks).map((x) => [
            t("tv.r.rank", { n: x.rank }),
            { bar: num(x.count) },
            fmt(num(x.count)),
            { t: pct(num(x.count), num(ft.fromHint)), dim: 1 },
          ]),
          { empty: t("tv.e.rank") }
        ),
        tbl(
          t("tv.h.topScore"),
          [H("band"), "", H("calls"), H("share")],
          [
            [t("tv.r.required", { n: must }), num(ts.required)],
            [t("tv.r.optional", { a: floor, b: must - 1 }), num(ts.optional)],
            [t("tv.r.below", { n: floor }), num(ts.below_floor)],
          ].map(([k, v]) => [k, { bar: v, max: Math.max(1, tsTotal) }, fmt(v), { t: pct(v, tsTotal), dim: 1 }]),
          { notes: [num(ts.none) > 0 ? note(t("tv.n.noCandidate", { n: fmt(ts.none) })) : null] }
        ),
      ],
    ],
  };
}

// ── 02 context tax ───────────────────────────────────────────────────────
function contextTax(c) {
  c = c || {};
  const H = (k) => t(`tv.col.${k}`);
  const ledger = (rows) =>
    arr(rows)
      .filter((r) => num(r.emissions) > 0)
      .map((r) => [
        String(r.kind ?? ""),
        { bar: num(r.tokens) },
        fmt(num(r.tokens)),
        { t: fmt(num(r.emissions)), dim: 1 },
        { t: num(r.unknown) ? fmt(r.unknown) : "", dim: 1 },
      ]);
  const laneSum = arr(c.lanes).reduce((n, r) => n + num(r.tokens), 0),
    toolSum = arr(c.tools).reduce((n, r) => n + num(r.tokens), 0);
  const a = c.archival || {};
  const memRows = (list) =>
    arr(list).map((x) => [`${fmt(num(x.emitted))}×`, { t: String(x.type ?? ""), dim: 1 }, String(x.id ?? "")]);
  const memHead = [
    { t: H("emitted"), kind: "num" },
    { t: H("type"), kind: "tag" },
    { t: H("memory"), kind: "id" },
  ];
  const pres = ledger(c.loadByPresentation);
  const daily = arr(c.daily);
  return {
    id: "context",
    title: t("tv.s.context"),
    q: t("tv.q.context"),
    key: fmt(num(c.totalTokens)),
    keyLabel: t("tv.k.tokens"),
    chart: daily.length
      ? {
          legend: [
            { t: t("tv.lg.lanes"), c: "a" },
            { t: t("tv.lg.tools"), c: "b" },
          ],
          bars: daily.map((d) => ({
            day: String(d.day ?? ""),
            a: num(d.lanes),
            b: num(d.tools),
            title:
              t("tv.tip.ctx", { d: d.day, a: fmt(num(d.lanes)), b: fmt(num(d.tools)), s: num(d.sessions) }) +
              (num(d.unknown) ? t("tv.tip.unknown", { n: d.unknown }) : ""),
          })),
        }
      : null,
    chartEmpty: daily.length ? "" : t("tv.e.emissions"),
    topNotes: [
      note(t("tv.n.estimator", { e: c.estimator || "", n: fmt(num(c.totalTokens)), a: fmt(laneSum), b: fmt(toolSum) })),
      num(c.totalUnknown) > 0 ? note(t("tv.n.unknownSize", { n: fmt(c.totalUnknown) }), true) : null,
    ],
    cols: [
      [
        tbl(t("tv.h.byLane"), [H("lane"), "", H("tokens"), H("emissions"), H("unknown")], ledger(c.lanes), {
          minW: "380px",
          empty: "—",
        }),
        tbl(t("tv.h.byTool"), [H("tool"), "", H("tokens"), H("emissions"), H("unknown")], ledger(c.tools), {
          minW: "380px",
          empty: "—",
        }),
        pres.length
          ? tbl(t("tv.h.byPresentation"), [H("presentation"), "", H("tokens"), H("loads"), H("unknown")], pres, {
              minW: "380px",
            })
          : null,
      ].filter(Boolean),
      [
        tbl(
          t("tv.h.topSessions"),
          [{ t: H("session"), kind: "label" }, H("tokens"), H("emissions")],
          arr(c.topSessions).map((x) => [
            { t: short(String(x.session ?? "")), dim: 1, mono: 1 },
            fmt(num(x.tokens)),
            { t: fmt(num(x.emissions)), dim: 1 },
          ]),
          { empty: t("tv.e.sessions"), notes: [note(t("tv.n.attributed"))] }
        ),
        tbl(t("tv.h.archival"), memHead, memRows(a.candidates), {
          empty: t("tv.e.none"),
          notes: [num(a.unknownTyped) > 0 ? note(t("tv.n.unknownTyped", { n: a.unknownTyped }), true) : null],
        }),
        tbl(t("tv.h.directives", { n: arr(a.directives).length }), memHead, memRows(a.directives), {
          empty: t("tv.e.none"),
          notes: [
            note(t("tv.n.directives")),
            num(a.untypedEmissions) > 0
              ? note(t("tv.n.typeCoverage", { a: fmt(num(a.typedEmissions)), b: fmt(a.untypedEmissions) }))
              : null,
          ],
        }),
      ],
    ],
  };
}

// ── 03 hint suppression ──────────────────────────────────────────────────
/** #484: in shadow nothing leaves the payload — no "removed"/"avoided" wording there. */
function suppressionLabels(modes) {
  const list = arr(modes);
  const live = list.some((m) => m.mode === "live"),
    shadow = list.some((m) => m.mode !== "live");
  return {
    verb: t(live && shadow ? "tv.hs.verbMixed" : shadow ? "tv.hs.verbShadow" : "tv.hs.verbLive"),
    tokensLabel: t(shadow ? "tv.hs.payload" : "tv.hs.payloadAvoided"),
    heading: t(shadow ? "tv.hs.matched" : "tv.hs.suppressed"),
    tokensNote: t(shadow ? "tv.hs.tokNoteShadow" : "tv.hs.tokNoteLive"),
    modeLine: shadow ? t("tv.hs.mode", { m: list.map((m) => `${m.mode}×${m.calls}`).join(", ") }) : null,
  };
}

function suppression(hs) {
  const base = { id: "suppression", title: t("tv.s.suppression") };
  if (!hs) {
    return {
      ...base,
      q: t("tv.q.suppression", { v: t("tv.hs.verbLive") }),
      key: "—",
      keyLabel: t("tv.k.hints"),
      cols: [[empty(null, t("tv.e.suppression"), [note(t("tv.n.suppressionScope"))])]],
    };
  }
  const l = suppressionLabels(hs.modes);
  const H = (k) => t(`tv.col.${k}`);
  return {
    ...base,
    q: t("tv.q.suppression", { v: l.verb }),
    key: fmt(num(hs.hints)),
    keyLabel: t("tv.k.hints"),
    figs: [
      fig(t("tv.hs.hints", { v: l.verb }), fmt(num(hs.hints)), t("tv.hs.calls", { n: fmt(num(hs.calls)) }), true),
      fig(l.tokensLabel, `~${fmt(num(hs.tokensAvoided))}`, t("tv.hs.tokens", { n: fmt(num(hs.unknownTokenCalls)) })),
      fig(t("tv.hs.versions"), fmt(num(hs.uniqueMemories))),
    ],
    topNotes: [note(l.modeLine)],
    cols: [
      [
        tbl(
          t("tv.h.byType"),
          [H("type"), "", l.verb],
          arr(hs.byType).map((r) => [String(r.type ?? ""), { bar: num(r.count) }, fmt(num(r.count))]),
          { empty: "—" }
        ),
      ],
      [
        tbl(
          l.heading,
          [{ t: H("memory"), kind: "id" }, { t: H("type"), kind: "tag" }, l.verb, H("priorSurfaces")],
          arr(hs.topMemories).map((r) => [
            String(r.id ?? ""),
            { t: String(r.type ?? ""), dim: 1 },
            fmt(num(r.count)),
            { t: fmt(num(r.surfaced)), dim: 1 },
          ]),
          { minW: "420px", empty: "—", notes: [note(t("tv.n.versionLocal", { x: l.tokensNote }))] }
        ),
      ],
    ],
  };
}

// ── 04 budget shadow ─────────────────────────────────────────────────────
function budget(b) {
  const base = { id: "budget", title: t("tv.s.budget"), q: t("tv.q.budget"), keyLabel: t("tv.k.trimmed") };
  if (!b) return { ...base, key: "—", cols: [[empty(null, t("tv.e.budget"))]] };
  const H = (k) => t(`tv.col.${k}`);
  const maxT = Math.max(1, ...arr(b.byLane).map((r) => num(r.tokens)));
  const daily = arr(b.daily);
  return {
    ...base,
    key: pct(num(b.tokensTrimmed), num(b.tokens)),
    verdict: t("tv.v.budget", {
      b: fmt(num(b.budget)),
      a: fmt(num(b.sessionsAffected)),
      s: fmt(num(b.sessions)),
      t: fmt(num(b.tokensTrimmed)),
      n: fmt(num(b.tokens)),
      p: pct(num(b.tokensTrimmed), num(b.tokens)),
    }),
    chart: daily.length
      ? {
          legend: [
            { t: t("tv.lg.emitted"), c: "b" },
            { t: t("tv.lg.trimmed"), c: "a" },
          ],
          // a = trimmed part on top, b = the rest that would still be injected.
          bars: daily.map((d) => ({
            day: String(d.day ?? ""),
            a: num(d.tokensTrimmed),
            b: Math.max(0, num(d.tokens) - num(d.tokensTrimmed)),
            title: t("tv.tip.budget", {
              d: d.day,
              a: fmt(num(d.tokens)),
              b: fmt(num(d.tokensTrimmed)),
              n: num(d.wouldDrop),
              s: num(d.sessionsAffected),
            }),
          })),
        }
      : null,
    cols: [
      [
        tbl(
          t("tv.h.byLane"),
          [H("lane"), "", H("tokens"), H("emissions"), H("wouldDrop"), H("tokensTrimmed"), H("share")],
          arr(b.byLane).map((r) => [
            String(r.lane ?? ""),
            { bar: num(r.tokensTrimmed), max: maxT },
            fmt(num(r.tokens)),
            { t: fmt(num(r.emissions)), dim: 1 },
            { t: fmt(num(r.wouldDrop)), dim: !(num(r.wouldDrop) > 0) },
            { t: fmt(num(r.tokensTrimmed)), ok: num(r.tokensTrimmed) > 0, dim: !(num(r.tokensTrimmed) > 0) },
            { t: pct(num(r.tokensTrimmed), num(r.tokens)), dim: 1 },
          ]),
          {
            minW: "560px",
            empty: "—",
            notes: [
              b.firstOverAtEmission !== null && b.firstOverAtEmission !== undefined
                ? note(t("tv.n.firstOver", { n: fmt(num(b.firstOverAtEmission)) }))
                : null,
              arr(b.budgets).length > 1
                ? note(t("tv.n.budgetChanged", { b: arr(b.budgets).map(fmt).join(" → ") }), true)
                : null,
              note(t("tv.n.granularity")),
              note(t("tv.n.ledger")),
            ],
          }
        ),
      ],
    ],
  };
}

// ── 05 latency ───────────────────────────────────────────────────────────
function latency(l) {
  l = l || {};
  const H = (k) => t(`tv.col.${k}`);
  const lanes = arr(l.lanes),
    daily = arr(l.daily);
  const hook = lanes.find((r) => r.lane === "hook_call") || lanes[0];
  const maxP = Math.max(1, ...lanes.map((r) => num(r.p95)));
  return {
    id: "latency",
    title: t("tv.s.latency"),
    q: t("tv.q.latency"),
    key: hook ? ms(hook.median) : "—",
    keyLabel: t("tv.k.hookMedian"),
    chart: daily.length
      ? {
          legend: [
            { t: t("tv.lg.median"), c: "a" },
            { t: t("tv.lg.p95"), c: "mark", line: true },
            { t: t("tv.lg.recall"), c: "mark2", line: true },
          ],
          bars: daily.map((d) => ({
            day: String(d.day ?? ""),
            a: num(d.hook?.median),
            b: 0,
            m: d.hook ? num(d.hook.p95) : null,
            m2: d.recall ? num(d.recall.median) : null,
            title: t("tv.tip.lat", {
              d: d.day,
              a: ms(d.hook?.median),
              p: ms(d.hook?.p95),
              n: num(d.hook?.n),
              r: ms(d.recall?.median),
              rn: num(d.recall?.n),
            }),
          })),
          unit: " ms",
        }
      : null,
    chartEmpty: daily.length ? "" : t("tv.e.latency"),
    cols: [
      [
        tbl(
          t("tv.h.byLane"),
          [H("lane"), "", H("median"), H("p95"), H("n")],
          lanes.map((r) => [
            String(r.lane ?? ""),
            { bar: num(r.median), max: maxP },
            ms(r.median),
            { t: ms(r.p95), dim: 1 },
            { t: fmt(num(r.n)), dim: 1 },
          ]),
          { minW: "400px", empty: t("tv.e.latency"), notes: [note(t("tv.n.latency"))] }
        ),
      ],
    ],
  };
}

// ── 06 evidence gate ─────────────────────────────────────────────────────
function evidence(ev) {
  const base = { id: "evidence", title: t("tv.s.evidence"), q: t("tv.q.evidence") };
  if (!ev) return { ...base, key: "—", keyLabel: "", cols: [[empty(null, t("tv.e.evidence"))]] };
  const H = (k) => t(`tv.col.${k}`);
  const acc = ev.acceptance || {},
    cr = ev.criteria || {};
  const crit = (label, v, target, ok, text) => [
    label,
    { bar: target > 0 ? Math.min(target, v) : 0, max: Math.max(1, target), mute: !ok },
    { t: text, ok },
  ];
  const mix = arr(ev.decisions),
    mixTotal = mix.reduce((n, d) => n + num(d.count), 0);
  const dv = ev.divergence || {},
    dvTotal = num(dv.agree) + num(dv.withholds) + num(dv.promotes);
  const viaHop = arr(ev.requiredByHop).find((x) => x.hop === "1-hop")?.count ?? 0;
  const gate = gateOf(ev);
  return {
    ...base,
    key: gate,
    keyLabel: t("tv.k.days", { a: num(acc.days), b: num(cr.minDays) }),
    verdict: acc.route
      ? t("tv.v.reached", { r: acc.route })
      : t("tv.v.notYet", { m: arr(acc.missing).join(", "), a: num(acc.days), b: num(cr.minDays) }),
    verdictOk: !!acc.route,
    cols: [
      [
        tbl(
          t("tv.h.acceptance"),
          [{ t: H("criterion"), kind: "label" }, "", H("value")],
          [
            crit(
              t("tv.r.decisions"),
              num(acc.decisions),
              num(cr.minDecisions),
              num(acc.decisions) >= num(cr.minDecisions),
              `${fmt(num(acc.decisions))} / ${num(cr.minDecisions)}`
            ),
            crit(
              t("tv.r.sessions"),
              num(acc.sessions),
              num(cr.minSessions),
              num(acc.sessions) >= num(cr.minSessions),
              `${fmt(num(acc.sessions))} / ${num(cr.minSessions)}`
            ),
            crit(
              t("tv.r.share"),
              num(acc.topSessionShare),
              num(cr.maxSessionShare),
              num(acc.topSessionShare) <= num(cr.maxSessionShare),
              `${dec((num(acc.topSessionShare) * 100).toFixed(1))} % ≤ ${dec(String(num(cr.maxSessionShare) * 100))} %`
            ),
            crit(
              t("tv.r.days"),
              num(acc.days),
              num(cr.minDays),
              num(acc.days) >= num(cr.minDays),
              `${num(acc.days)} / ${num(cr.minDays)}`
            ),
          ],
          {
            notes: [
              note(
                t("tv.n.calls", {
                  a: fmt(num(ev.shadow?.calls)),
                  b: fmt(num(ev.shadow?.decisions)),
                  d: num(ev.shadow?.days),
                  c: fmt(num(ev.live?.calls)),
                  e: fmt(num(ev.live?.decisions)),
                }) + (num(ev.live?.calls) > 0 ? t("tv.n.active") : "")
              ),
              num(ev.excluded?.degraded) + num(ev.excluded?.failed) > 0
                ? note(
                    t("tv.n.excluded", { a: fmt(num(ev.excluded?.degraded)), b: fmt(num(ev.excluded?.failed)) }),
                    true
                  )
                : null,
            ],
          }
        ),
      ],
      [
        tbl(
          t("tv.h.mix"),
          [H("decision"), "", H("count"), H("share")],
          mix.map((d) => [
            String(d.decision ?? ""),
            { bar: num(d.count), max: Math.max(1, mixTotal) },
            fmt(num(d.count)),
            { t: pct(num(d.count), mixTotal), dim: 1 },
          ]),
          {
            empty: "—",
            notes: [
              arr(ev.abstainReasons).length
                ? note(
                    t("tv.n.abstain", {
                      l: arr(ev.abstainReasons)
                        .map((r) => `${r.reason} ${fmt(num(r.count))}`)
                        .join(" · "),
                    })
                  )
                : null,
              arr(ev.requiredByHop).length
                ? note(
                    t("tv.n.byHop", {
                      l: arr(ev.requiredByHop)
                        .map((r) => `${r.hop} ${fmt(num(r.count))}`)
                        .join(" · "),
                    })
                  )
                : null,
              viaHop > 0 ? note(t("tv.n.viaHop", { n: viaHop }), true) : null,
            ],
          }
        ),
        dvTotal > 0
          ? tbl(
              t("tv.h.divergence"),
              [{ t: "", kind: "text" }, H("decisions"), H("share")],
              [
                [t("tv.r.agree"), fmt(num(dv.agree)), { t: pct(num(dv.agree), dvTotal), dim: 1 }],
                [t("tv.r.withholds"), fmt(num(dv.withholds)), { t: pct(num(dv.withholds), dvTotal), dim: 1 }],
                [t("tv.r.promotes"), fmt(num(dv.promotes)), { t: pct(num(dv.promotes), dvTotal), dim: 1 }],
              ],
              {
                notes: [
                  note(t("tv.n.bm25")),
                  num(dv.unfused) + num(dv.unknownSpace) > 0
                    ? note(t("tv.n.unfused", { a: fmt(num(dv.unfused)), b: fmt(num(dv.unknownSpace)) }))
                    : null,
                ],
              }
            )
          : empty(t("tv.h.divergence"), t("tv.e.comparable"), [note(t("tv.n.bm25"))]),
      ],
    ],
  };
}

// ── 07 saves ─────────────────────────────────────────────────────────────
function saveSuggestions(ss) {
  if (!ss) return null;
  const H = (k) => t(`tv.col.${k}`);
  return tbl(
    t("tv.h.suggestions"),
    ["", H("sessions")],
    [
      [t("tv.r.suggested"), fmt(num(ss.suggestedSessions))],
      [
        t("tv.r.savedOf"),
        { t: `${fmt(num(ss.savedSessions))} (${pct(num(ss.savedSessions), num(ss.suggestedSessions))})`, ok: 1 },
      ],
      [t("tv.r.savedAfter"), fmt(num(ss.savedAfterSuggestion))],
    ],
    {
      notes: [
        note(
          t("tv.n.joined", { a: fmt(num(ss.savesWithCallerSession)), b: fmt(num(ss.saves)) }) +
            t(num(ss.savesWithCallerSession) < num(ss.saves) ? "tv.n.joinedLower" : "tv.n.joinedEnd")
        ),
      ],
    }
  );
}

function saves(sv, ss) {
  const base = { id: "saves", title: t("tv.s.saves"), q: t("tv.q.saves"), keyLabel: t("tv.k.written") };
  const sug = saveSuggestions(ss);
  if (!sv)
    return { ...base, key: "—", cols: [[empty(null, t("tv.e.saves"))], sug ? [sug] : []].filter((c) => c.length) };
  const H = (k) => t(`tv.col.${k}`);
  const attempted = num(sv.written) + num(sv.held);
  const reasons = arr(sv.byReason);
  const claim = reasons.find((r) => r.reason === "claim_gate")?.count ?? 0;
  const label = (k) => {
    const v = t(`tv.reason.${k}`);
    return v === `tv.reason.${k}` ? String(k) : v;
  };
  return {
    ...base,
    key: fmt(num(sv.written)),
    figs: [
      fig(t("tv.f.attempted"), fmt(attempted)),
      fig(
        t("tv.f.written"),
        fmt(num(sv.written)),
        t("tv.f.writtenSub", { a: fmt(num(sv.created)), b: fmt(num(sv.overwritten)) }),
        true
      ),
      fig(t("tv.f.held"), fmt(num(sv.held)), t("tv.f.heldSub", { p: pct(num(sv.held), attempted) })),
    ],
    cols: [
      [
        tbl(
          t("tv.h.heldExit"),
          [{ t: H("exit"), kind: "text" }, "", H("holds"), H("share")],
          reasons.map((r) => [
            label(r.reason),
            { bar: num(r.count), mute: 1 },
            fmt(num(r.count)),
            { t: pct(num(r.count), num(sv.held)), dim: 1 },
          ]),
          {
            empty: t("tv.e.held"),
            notes: [
              num(sv.claimedTotal) > 0
                ? note(t("tv.n.claim", { a: fmt(num(sv.claimedTotal)), b: fmt(num(claim)) }))
                : null,
              note(t("tv.n.heldPrivate")),
            ],
          }
        ),
      ],
      sug ? [sug] : [],
    ].filter((c) => c.length),
  };
}

// ── 08 code awareness ────────────────────────────────────────────────────
function code(ca) {
  const base = { id: "code", title: t("tv.s.code"), q: t("tv.q.code"), keyLabel: t("tv.k.blocks") };
  if (!ca) return { ...base, key: "—", cols: [[empty(null, t("tv.e.code"))]] };
  const H = (k) => t(`tv.col.${k}`);
  const a = ca.active || {},
    b = ca.block || {},
    tools = arr(a.tools),
    rf = a.refresh || {};
  const dl = a.delivered || {
    blocks: 0,
    dedupeHits: 0,
    byLane: [],
    byBasis: [],
    filesNamed: 0,
    tokensTotal: 0,
    tokensMedian: 0,
    p50: null,
    p90: null,
  };
  const sum = (k) => tools.reduce((n, x) => n + num(x[k]), 0);
  const kv = (list) =>
    arr(list)
      .map((r) => `${r.key} ${fmt(num(r.count))}`)
      .join(" · ");
  const reason = (k) => {
    const v = t(`tv.ua.${k}`);
    return v === `tv.ua.${k}` ? String(k) : v;
  };
  const repos = arr(a.repos);
  const asked = repos.filter((r) => r.repo !== "(temporary tree)" && num(r.toolCalls) > 0).length;
  const broken = repos.some((r) => num(r.externalTotal) > 0 && num(r.externalResolved) === 0);
  const maxP50 = Math.max(1, ...tools.map((x) => num(x.p50)));
  const kindRows = tools.flatMap((x) =>
    arr(x.byKind).map((r) => [{ t: String(x.tool ?? ""), dim: 1 }, String(r.key ?? ""), fmt(num(r.count))])
  );
  const reasonRows = tools.flatMap((x) =>
    arr(x.byUnavailableReason).map((r) => [{ t: String(x.tool ?? ""), dim: 1 }, reason(r.key), fmt(num(r.count))])
  );
  return {
    ...base,
    key: fmt(num(dl.blocks)),
    figs: [
      fig(t("tv.f.toolCalls"), fmt(sum("calls")), tn("tv.f.reposAsked", asked, { n: asked })),
      fig(
        t("tv.f.answered"),
        pct(sum("ok"), sum("calls")),
        t("tv.f.unavailable", { n: fmt(sum("unavailable")) }),
        true
      ),
      fig(t("tv.f.delivered"), fmt(num(dl.blocks)), t("tv.f.tokens", { n: fmt(num(dl.tokensTotal)) })),
      fig(
        t("tv.f.followed"),
        pct(num(b.blocksFollowed), num(b.blocksWithListed)),
        t("tv.f.followedSub", { a: fmt(num(b.blocksFollowed)), b: fmt(num(b.blocksWithListed)) }),
        num(b.blocksFollowed) > 0
      ),
    ],
    cols: [
      [
        tbl(
          t("tv.h.tools"),
          [H("tool"), "", H("calls"), H("answered"), H("nothingFound"), H("unavailable")],
          tools.map((x) => [
            String(x.tool ?? ""),
            { bar: num(x.ok), max: Math.max(1, ...tools.map((y) => num(y.calls))) },
            fmt(num(x.calls)),
            { t: `${fmt(num(x.ok))} (${pct(num(x.ok), num(x.calls))})`, ok: num(x.ok) > 0 },
            { t: fmt(num(x.noAnswer)), dim: 1 },
            { t: fmt(num(x.unavailable)), dim: !(num(x.unavailable) > 0) },
          ]),
          { minW: "460px", empty: t("tv.e.toolCall") }
        ),
        tools.length
          ? tbl(
              t("tv.h.reach"),
              [H("tool"), "", H("p50"), H("p90"), H("filesNamed")],
              tools.map((x) => [
                String(x.tool ?? ""),
                { bar: num(x.p50), max: maxP50 },
                lat(x.p50),
                { t: lat(x.p90), dim: 1 },
                { t: x.tool === "find_code" && num(x.filesNamed) === 0 ? t("tv.na") : fmt(num(x.filesNamed)), dim: 1 },
              ]),
              { minW: "400px" }
            )
          : null,
        kindRows.length
          ? tbl(
              t("tv.h.byKind"),
              [{ t: H("tool"), kind: "tag" }, { t: H("laneBasis"), kind: "text" }, H("calls")],
              kindRows
            )
          : null,
        reasonRows.length
          ? tbl(
              t("tv.h.why"),
              [{ t: H("tool"), kind: "tag" }, { t: H("reason"), kind: "text" }, H("calls")],
              reasonRows
            )
          : null,
        notesOnly(null, [note(t("tv.n.unavailable"))]),
      ].filter(Boolean),
      [
        rf.started > 0 || rf.ok > 0
          ? tbl(
              t("tv.h.refresh"),
              ["", H("runs")],
              [
                [t("tv.r.started"), fmt(num(rf.started))],
                [t("tv.r.ok"), { t: fmt(num(rf.ok)), ok: num(rf.ok) > 0 }],
                [t("tv.r.failed"), { t: fmt(num(rf.failed)), warn: num(rf.failed) > 0, dim: !(num(rf.failed) > 0) }],
                [
                  t("tv.r.interrupted"),
                  { t: fmt(num(rf.interrupted)), warn: num(rf.interrupted) > 0, dim: !(num(rf.interrupted) > 0) },
                ],
                [
                  t("tv.r.locked"),
                  { t: `${fmt(num(rf.locked))} · ${fmt(num(rf.skipped))} · ${fmt(num(rf.givenUp))}`, dim: 1 },
                ],
                [t("tv.r.duration"), `${lat(rf.p50)} / ${lat(rf.p90)}`],
              ],
              {
                notes: [
                  note(t("tv.n.refresh")),
                  arr(rf.byReason).length ? note(t("tv.n.triggered", { l: kv(rf.byReason) })) : null,
                  arr(rf.failures).length ? note(t("tv.n.failures", { l: kv(rf.failures) }), true) : null,
                ],
              }
            )
          : empty(t("tv.h.refresh"), t("tv.e.refresh"), [note(t("tv.n.refresh"))]),
        tbl(
          t("tv.h.repos"),
          [{ t: H("repo"), kind: "text" }, H("toolCalls"), H("refreshes"), H("external")],
          repos.map((r) => [
            String(r.repo ?? ""),
            fmt(num(r.toolCalls)),
            { t: fmt(num(r.refreshes)), dim: 1 },
            {
              t:
                r.externalTotal === null || r.externalTotal === undefined
                  ? "—"
                  : `${fmt(num(r.externalResolved))} / ${fmt(num(r.externalTotal))}`,
              warn: num(r.externalTotal) > 0 && num(r.externalResolved) === 0,
              dim: !(num(r.externalTotal) > 0 && num(r.externalResolved) === 0),
            },
          ]),
          { empty: t("tv.e.none"), notes: [broken ? note(t("tv.n.broken"), true) : null] }
        ),
        dl.blocks > 0 || dl.dedupeHits > 0
          ? tbl(
              t("tv.h.delivered"),
              ["", H("value")],
              [
                [t("tv.r.injected"), { t: fmt(num(dl.blocks)), ok: num(dl.blocks) > 0 }],
                [t("tv.r.dedupe"), { t: fmt(num(dl.dedupeHits)), dim: 1 }],
                [t("tv.r.byLane"), kv(dl.byLane) || "—"],
                [t("tv.r.byBasis"), kv(dl.byBasis) || "—"],
                [t("tv.r.cost"), t("tv.r.costV", { a: fmt(num(dl.tokensTotal)), b: fmt(num(dl.tokensMedian)) })],
                [t("tv.r.reach"), t("tv.r.reachFiles", { n: fmt(num(dl.filesNamed)) })],
                [t("tv.r.latency"), `${lat(dl.p50)} / ${lat(dl.p90)}`],
              ],
              { notes: [note(t("tv.n.wholeFile"))] }
            )
          : empty(t("tv.h.delivered"), t("tv.e.delivered"), [note(t("tv.n.wholeFile"))]),
        num(b.withCodeBlock) > 0 || num(b.withAppliesTo) > 0
          ? tbl(
              t("tv.h.injected"),
              ["", H("value")],
              [
                [
                  t("tv.r.depBlock"),
                  t("tv.r.depBlockV", {
                    a: fmt(num(b.withCodeBlock)),
                    b: fmt(num(b.calls)),
                    p: pct(num(b.withCodeBlock), num(b.calls)),
                  }),
                ],
                [t("tv.r.cost"), t("tv.r.costV", { a: fmt(num(b.codeTokensTotal)), b: fmt(num(b.codeTokensMedian)) })],
                [t("tv.r.shareWE"), pct(num(b.codeTokensTotal), num(b.hintTokensTotal))],
                [
                  t("tv.r.reach"),
                  t("tv.r.reachDeps", { a: fmt(num(b.dependentsTotal)), b: fmt(num(b.dependentsMedian)) }),
                ],
                [
                  t("tv.r.stale"),
                  { t: fmt(num(b.staleBlocks)), warn: num(b.staleBlocks) > 0, dim: !(num(b.staleBlocks) > 0) },
                ],
                [
                  t("tv.r.affects"),
                  t("tv.r.affectsV", {
                    a: fmt(num(b.withAppliesTo)),
                    b: fmt(num(b.appliesToTokensTotal)),
                    c: fmt(num(b.appliesToCount)),
                  }),
                ],
              ],
              { notes: [note(t("tv.n.costReach"))] }
            )
          : empty(t("tv.h.injected"), t("tv.e.injected"), [note(t("tv.n.costReach"))]),
      ],
    ],
  };
}

// ── 09 session start ─────────────────────────────────────────────────────
function sessionStart(ss) {
  ss = ss || {};
  const base = {
    id: "start",
    title: t("tv.s.start"),
    q: t("tv.q.start"),
    key: fmt(num(ss.totalTokens)),
    keyLabel: t("tv.k.tokens"),
  };
  if (!num(ss.starts)) return { ...base, cols: [[empty(null, t("tv.e.starts"))]] };
  const H = (k) => t(`tv.col.${k}`);
  const pl = ss.pendingLanes;
  const lane = (name, l) => [
    name,
    fmt(num(l?.entries)),
    { t: `${num(l?.presentIn)}/${num(pl?.withLanes)}`, dim: 1 },
    fmt(num(l?.avgChars)),
  ];
  return {
    ...base,
    cols: [
      [
        tbl(
          t("tv.h.parts", { a: fmt(num(ss.withParts)), b: fmt(num(ss.totalTokens)) }),
          [H("part"), "", H("tokens"), H("share"), H("avgStart"), H("presentIn")],
          arr(ss.parts).map((p) => [
            String(p.part ?? ""),
            { bar: num(p.tokens), max: Math.max(1, num(ss.totalTokens)) },
            fmt(num(p.tokens)),
            { t: pct(num(p.tokens), num(ss.totalTokens)), dim: 1 },
            fmt(num(p.avgPerStart)),
            { t: `${num(p.presentIn)}/${num(ss.withParts)}`, dim: 1 },
          ]),
          {
            minW: "520px",
            empty: t("tv.e.parts"),
            notes: [
              num(ss.withoutParts) > 0
                ? note(t("tv.n.predate", { a: fmt(num(ss.withoutParts)), b: fmt(num(ss.starts)) }), true)
                : null,
            ],
          }
        ),
      ],
      [
        tbl(
          t("tv.h.bySource"),
          [H("source"), H("starts"), { t: H("topParts"), kind: "text" }],
          arr(ss.bySource).map((x) => [
            String(x.source ?? ""),
            { t: fmt(num(x.n)), dim: 1 },
            {
              t: arr(x.parts)
                .slice(0, 5)
                .map((p) => `${p.part} ${fmt(num(p.avg))}`)
                .join(" · "),
              dim: 1,
            },
          ]),
          { empty: "—", notes: [note(t("tv.n.cadence"))] }
        ),
        !pl || !num(pl.withLanes)
          ? empty(t("tv.h.pending"), t("tv.e.pending"))
          : tbl(
              t("tv.h.pending"),
              [H("lane"), H("entries"), H("presentIn"), H("avgChars")],
              [lane("recency", pl.recency), lane("trends", pl.trends)],
              {
                notes: [
                  num(pl.withoutLanes) > 0
                    ? note(t("tv.n.pendingPredate", { n: fmt(num(pl.withoutLanes)) }), true)
                    : null,
                ],
              }
            ),
      ],
    ],
  };
}

/** Window line under the head (old #tv-window-note, #664/#875). */
function windowNote(w) {
  const span = w.from && w.to ? `${String(w.from).slice(0, 10)} → ${String(w.to).slice(0, 10)}` : t("tv.wn.none");
  return [
    span,
    t("tv.wn.events", { n: fmt(num(w.events)) }),
    num(w.excludedEval) ? t("tv.wn.excluded", { n: fmt(w.excludedEval) }) : null,
    num(w.foldedDuplicates) ? t("tv.wn.folded", { n: fmt(w.foldedDuplicates) }) : null,
    num(w.excludedRestart) ? t("tv.wn.restart", { n: fmt(w.excludedRestart) }) : null,
    t("tv.wn.retention", { n: num(w.retentionDays) }),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Report → { overview, sections, windowNote, events, days }. */
export function buildModel(r) {
  const w = r.window || {};
  const sections = [
    quality(r.quality, r.thresholds),
    contextTax(r.contextTax),
    suppression(r.hintSuppression),
    budget(r.budgetShadow),
    latency(r.latency),
    evidence(r.evidence),
    saves(r.saves, r.saveSuggestions),
    code(r.codeAwareness),
    sessionStart(r.sessionStart),
  ].map((s, i) => ({ ...s, n: String(i + 1).padStart(2, "0") }));
  return { overview: overview(r), sections, windowNote: windowNote(w), events: num(w.events), days: num(w.days) };
}

/** Plain text of one table row, lower-cased, for Find. */
export function rowText(row) {
  return row
    .map((c) => (c && typeof c === "object" ? ("bar" in c ? "" : (c.t ?? "")) : String(c)))
    .join(" ")
    .toLowerCase();
}

/**
 * Find (prototype buildTelemetry finalize): hits per section — title/question
 * once, every matching h3 and table row once. Returns Map id → hits.
 */
export function findHits(sections, query) {
  const q = query.trim().toLowerCase();
  const out = new Map();
  for (const s of sections) {
    if (!q) {
      out.set(s.id, 0);
      continue;
    }
    let n = `${s.title} ${s.q}`.toLowerCase().includes(q) ? 1 : 0;
    for (const col of s.cols)
      for (const b of col) {
        if ((b.h3 || "").toLowerCase().includes(q)) n++;
        for (const r of b.rows || []) if (rowText(r).includes(q)) n++;
      }
    out.set(s.id, n);
  }
  return out;
}
