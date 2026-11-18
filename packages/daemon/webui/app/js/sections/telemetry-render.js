// Telemetry area — DOM for one report section (prototype TelemetrySection.dc.html)
// and the three page heads (centered / hud / hero). Specs come from
// telemetry-model.js; styles in css/telemetry.css. Dynamic sizes go through
// CSS custom properties (CSP style-src 'self').
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { fmt, dec, rowText } from "./telemetry-model.js";
import { hud, hudRow, hudChip, hudNote, hudTiles } from "./hud.js";

// label: min-content instead of the prototype's 72px, so long lane names never run into the bar column.
const GRID = {
  label: "minmax(min-content, 2fr)",
  bar: "minmax(28px, 1.2fr)",
  id: "minmax(110px, 3fr)",
  text: "minmax(80px, 3fr)",
  tag: "max-content",
  num: "minmax(min-content, 84px)",
};

/** Text with the inline `bastra logs --stats` code span ({code} in the string). */
export function withCode(text) {
  const [a, b = ""] = text.split("{code}");
  return [a, h("code", { text: "bastra logs --stats" }), b];
}

function notes(list, cls) {
  return list.map((n) =>
    h(`p.${cls}`, { cls: n.warn ? "is-warn" : "" }, n.warn ? h("span.tv-note__pre", { text: "▲ " }) : null, n.t)
  );
}

function table(b, q) {
  const max = Math.max(
    1,
    ...b.rows.flatMap((r) =>
      r.filter((c) => c && typeof c === "object" && "bar" in c && c.max === undefined).map((c) => c.bar)
    )
  );
  const head = h(
    "div.tv-tr.tv-tr--head",
    null,
    b.head.map((x, i) =>
      h("span.tv-th", { cls: b.kinds[i] === "num" ? "is-num" : "", text: String(x).replace(/-/g, "‑") })
    )
  );
  const rows = b.rows.map((r) => {
    const hit = q && rowText(r).includes(q);
    return h(
      "div.tv-tr",
      { cls: hit ? "is-hit" : "" },
      r.map((c, i) => {
        const k = b.kinds[i];
        if (c && typeof c === "object" && "bar" in c) {
          const w = Math.max(c.bar > 0 ? 1 : 0, Math.min(100, (c.bar / (c.max ?? max)) * 100));
          return h(
            "span.tv-c.tv-c--bar",
            null,
            h("span.tv-bar", { cls: c.mute ? "is-mute" : "" }, h("span", { vars: { "--w": `${w.toFixed(1)}%` } }))
          );
        }
        const o = c && typeof c === "object" ? c : { t: String(c) };
        const txt = k === "id" ? String(o.t ?? "").replace(/\//g, "/​") : String(o.t ?? "");
        const sans = (k === "label" || k === "tag") && !o.mono;
        return h("span.tv-c", {
          cls: [
            sans ? "is-sans" : "",
            k === "num" ? "is-num" : "",
            k === "id" || k === "text" ? "is-wrap" : "",
            o.ok ? "is-ok" : o.warn ? "is-warn" : o.dim ? "is-dim" : "",
          ].join(" "),
          text: txt,
        });
      })
    );
  });
  return h("div.tv-tw", null, h("div.tv-t", { vars: { "--grid": b.kinds.map((k) => GRID[k]).join(" ") } }, head, rows));
}

function block(b, i, q) {
  return h(
    "div.tv-blk",
    { cls: i === 0 ? "is-first" : "" },
    b.h3 ? h("div.tv-h3", { cls: q && b.h3.toLowerCase().includes(q) ? "is-hit" : "", text: b.h3 }) : null,
    b.kind === "table" ? table(b, q) : null,
    b.kind === "empty" ? h("div.tv-empty", { text: b.empty }) : null,
    notes(b.notes || [], "tv-bnote")
  );
}

/** Section figures in the head variant's style (prototype figA / figB / figC). */
export function figures(figs, head, cls = "") {
  if (head === "hud")
    return hudTiles(
      figs.map((f) => ({
        k: f.k,
        v: f.v,
        sub: f.sub,
        color: f.ok ? "var(--accent)" : "var(--ink)",
        tick: f.ok ? "var(--accent)" : "var(--line-45)",
      })),
      { large: true, cls: `tv-figs-b ${cls}` }
    );
  if (head === "hero") {
    return h(
      "div.tv-figs-c",
      { cls },
      figs.map((f) => {
        const m = /^~?([\d.,]+)%$/.exec(f.v);
        const w = m ? `${Math.min(100, Number(m[1].replace(",", ".")))}%` : f.v === "shadow" ? "50%" : "100%";
        return h(
          "div.tv-fc",
          { cls: f.ok ? "is-ok" : "" },
          h("span.tv-fc__k", { text: f.k }),
          h("span.tv-fc__v", { text: f.v }),
          h("span.tv-fc__bar", null, h("span", { vars: { "--w": w } })),
          f.sub ? h("span.tv-fc__sub", { text: f.sub }) : null
        );
      })
    );
  }
  return h(
    "div.tv-figs-a",
    { cls },
    figs.map((f) =>
      h(
        "div.tv-fa",
        { cls: f.ok ? "is-ok" : "" },
        h("div.tv-fa__k", { text: f.k }),
        h("div.tv-fa__v", { text: f.v }),
        f.sub ? h("div.tv-fa__sub", { text: f.sub }) : null
      )
    )
  );
}

/** Y-axis maximum in the 44px column: 1.3M / 130k above 9 999. */
function axisNum(v) {
  if (v >= 1e6) return `${dec((v / 1e6).toFixed(1))}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return fmt(v);
}

function chart(c) {
  const bars = c.bars;
  const stacked = bars.some((b) => b.b > 0);
  const max = Math.max(1, ...bars.map((b) => Math.max(stacked ? b.a + b.b : b.a, b.m ?? 0, b.m2 ?? 0)));
  const pc = (v) => `${((v / max) * 100).toFixed(1)}%`;
  const day = (i) => (bars[i]?.day || "").slice(5);
  return [
    h(
      "div.tv-legend",
      null,
      c.legend.map((l) =>
        h("span", null, h("span.tv-legend__sw", { cls: `is-${l.c}${l.line ? " is-line" : ""}` }), l.t)
      )
    ),
    h(
      "div.tv-chart",
      null,
      h(
        "div.tv-chart__y",
        null,
        h("span", { text: `${axisNum(max)}${c.unit || ""}` }),
        h("span"),
        h("span", { text: "0" })
      ),
      h(
        "div.tv-chart__bars",
        { cls: bars.length > 20 ? "is-dense" : "" },
        bars.map((b) =>
          h(
            "div.tv-cb",
            { title: b.title },
            h("span.tv-cb__a", { vars: { "--h": pc(b.a) } }),
            h("span.tv-cb__b", { vars: { "--h": pc(b.b) } }),
            b.m != null ? h("span.tv-cb__m", { vars: { "--y": pc(b.m) } }) : null,
            b.m2 != null ? h("span.tv-cb__m.is-m2", { vars: { "--y": pc(b.m2) } }) : null
          )
        )
      ),
      h("span"),
      h(
        "div.tv-chart__x",
        null,
        h("span", { text: day(0) }),
        h("span", { text: day(Math.floor((bars.length - 1) / 2)) }),
        h("span", { text: day(bars.length - 1) })
      )
    ),
  ];
}

/**
 * One section. o.head: centered | hud | hero | none (tiles: the tile button
 * carries the head); o.mode: doc | tile | index; o.q: lower-cased query.
 */
export function section(s, o) {
  const head = o.head;
  const heads = {
    centered: () =>
      h(
        "div.tv-sh.tv-sh--a",
        null,
        h("span.tv-sh__n", { text: s.n }),
        h("h2", { text: s.title }),
        h("p", { text: s.q }),
        h("span.tv-sh__line")
      ),
    hud: () =>
      h(
        "div.tv-sh.tv-sh--b",
        null,
        h("span.tv-sh__box", { text: s.n }),
        h("div.tv-sh__row", null, h("h2", { text: s.title }), h("span.tv-sh__rule")),
        h("p", { text: s.q })
      ),
    hero: () =>
      h(
        "div.tv-sh.tv-sh--c",
        null,
        h("span.tv-sh__ghost", { text: s.n }),
        h("span.tv-sh__kick", { text: t("tv.sectionN", { n: s.n }) }),
        h("h2", { text: s.title }),
        h("p", { text: s.q })
      ),
  };
  const cols = s.cols.filter((c) => c.length);
  return h(
    "section.tv-sec",
    {
      id: `${o.idPrefix || "tv-"}${s.id}`,
      cls: [`tv-sec--${o.mode}`, o.flash ? "is-flash" : "", o.headHit ? "is-headhit" : ""].join(" "),
    },
    heads[head]?.(),
    s.verdict ? h("div.tv-verdict", { cls: s.verdictOk ? "is-ok" : "", text: s.verdict }) : null,
    s.figs ? figures(s.figs, o.figHead || head, "tv-secfigs") : null,
    s.chart ? chart(s.chart) : s.chartEmpty ? h("div.tv-empty", { text: s.chartEmpty }) : null,
    notes(s.topNotes ? s.topNotes.filter(Boolean) : [], "tv-tnote"),
    h(
      "div.tv-cols",
      {
        cls: [
          cols.length > 1 ? "is-two" : "",
          s.chart || s.figs || s.verdict || s.topNotes?.some(Boolean) ? "is-gap" : "",
        ].join(" "),
      },
      cols.map((col) =>
        h(
          "div.tv-col",
          null,
          col.map((b, i) => block(b, i, o.q))
        )
      )
    )
  );
}

/** Sparkline for a closed tile: last 14 chart bars, else the first table's bar column. */
export function spark(s) {
  let vals;
  if (s.chart) {
    const b = s.chart.bars.slice(-14);
    const m = Math.max(1, ...b.map((x) => x.a + x.b));
    vals = b.map((x) => (x.a + x.b) / m);
  } else {
    const tb = s.cols.flat().find((b) => b.kind === "table" && b.kinds.includes("bar"));
    const i = tb ? tb.kinds.indexOf("bar") : -1;
    const rows = tb ? tb.rows.slice(0, 6).map((r) => r[i].bar) : [];
    const m = Math.max(1, ...rows);
    vals = rows.length ? rows.map((v) => v / m) : [0.3];
  }
  return h(
    "div.tv-spark",
    null,
    vals.map((v) => h("span", { vars: { "--h": `${Math.max(2, v * 100).toFixed(1)}%` } }))
  );
}

// ── page heads ───────────────────────────────────────────────────────────
/** o: { model, head, daysLabel, updated, refreshNote } */
export function pageHead(o) {
  const m = o.model,
    ov = m.overview;
  if (o.head === "hud") {
    return [
      hud({
        cls: "tv-hud",
        kicker: t("tv.kicker"),
        title: t("tv.title"),
        text: withCode(t("tv.text")),
        side: [
          hudRow(hudChip(o.daysLabel, { on: true }), o.updated ? hudChip(o.updated, { dot: "var(--accent)" }) : null),
          hudNote(m.windowNote),
        ],
      }),
      figures(ov, "hud", "tv-ovfigs"),
    ];
  }
  if (o.head === "hero") {
    return [
      h(
        "div.tv-hero",
        null,
        h("span.tv-hero__kick", { text: t("tv.heroKicker", { d: o.daysLabel }) }),
        h("div.tv-hero__n", { text: fmt(m.events) }),
        h("span.tv-hero__sub", { text: t("tv.heroSub") }),
        h("h1", { text: t("tv.title") }),
        h("p", null, withCode(t("tv.textShort"))),
        h("span.tv-hero__note", {
          text: o.updated ? `${m.windowNote} · ${t("tv.updated", { t: o.updated })}` : m.windowNote,
        })
      ),
      figures(ov.slice(1), "hero", "tv-ovfigs"),
    ];
  }
  return [
    h(
      "div.tv-head",
      null,
      h("h1", { text: t("tv.titleLong") }),
      h("p", null, withCode(t("tv.text"))),
      h(
        "div.tv-head__meta",
        null,
        h("span.tv-head__win", { text: t("tv.window", { d: o.daysLabel }) }),
        h("span", { text: m.windowNote }),
        o.updated ? h("span", { text: `${t("tv.updated", { t: o.updated })} · ${t("tv.refreshes")}` }) : null
      )
    ),
    figures(ov, "centered", "tv-ovfigs"),
  ];
}
