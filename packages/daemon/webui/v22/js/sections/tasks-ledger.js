// Tasks calendar — "ledger" (default style): week or month grid, optional
// split with mini month + agenda (prototype calLgWeek / calLgMonth /
// calSplitPanel). Values follow the prototype's inline styles.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { S, emit, select } from "./tasks-store.js";
import { registerCalendarStyle } from "./tasks-styles.js";
import { H0, H1, pad, hm, d0, addDays, sameDay, mon0, isoWeek, WD, WD_MON, MONTHS, nowH, nowLabel, tzShort, dayItems, dated, tip, kcls,
  draggable, dropZone, dndRoot, composeAt, onSelect, wxMark, dayHead, label } from "./tasks-cal.js";

const span = () => (S.W >= 700 ? 7 : 3);

export function weekDays() {
  const today = d0(new Date()), n = span();
  const start = n === 7 ? addDays(mon0(today), S.off * 7) : addDays(today, -1 + S.off * 3);
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}
export function monthStart() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth() + S.off, 1); }

function weekBody(days, bw, bh) {
  const HP = bh / (H1 - H0), today = new Date(), nh = nowH();
  const ti = days.findIndex((d) => sameDay(d, today));
  const lgRow = (bw - 46) / days.length >= 158;
  const head = h("div.tk-wk__head", { vars: { "--n": days.length } },
    h("span.tk-wk__tz", { text: tzShort }),
    days.map((d) => { const td = sameDay(d, today);
      return h("div.tk-wk__dh", { cls: [td ? "is-today" : "", lgRow ? "" : "is-stack"].join(" ") }, h("span.tk-wk__bar"), dayHead(d, { stack: !lgRow, today: td })); }));
  const showNow = ti >= 0 && nh >= H0 && nh <= H1, nowTop = (nh - H0) * HP;
  const hours = h("div.tk-wk__hours");
  for (let i = 1; i < H1 - H0; i++) {
    if (!(HP >= 24 || i % 2 === 0) || i * HP + 6 >= bh) continue;
    if (showNow && Math.abs(i * HP - nowTop) <= 13) continue;
    hours.append(h("span.tk-wk__hr", { vars: { "--top": `${(i * HP).toFixed(1)}px` } }, pad(H0 + i), h("span", { text: ":00" })));
  }
  const cols = days.map((d) => {
    const items = dayItems(d), lanes = [];
    for (const x of items) { let li = lanes.findIndex((end) => end <= x.h); if (li < 0) { li = lanes.length; lanes.push(0); } lanes[li] = x.h + 1; x._li = li; }
    const n = Math.max(1, lanes.length), td = sameDay(d, today);
    const col = h("div.tk-wk__col", { cls: td ? "is-today" : "" }, items.map((x) => {
      const top = (Math.max(H0, Math.min(H1 - 1, x.h)) - H0) * HP + 1;
      const el = h("article.tk-ev", { cls: [kcls(x), HP < 36 ? "is-row" : "", n > 1 || HP < 40 ? "is-clamp1" : ""].join(" "), title: tip(x),
        vars: { "--top": `${top.toFixed(1)}px`, "--h": `${Math.max(10, HP - 2).toFixed(1)}px`, "--l": `calc(${(x._li / n) * 100}% + 1px)`, "--w": `calc(${100 / n}% - 2px)` },
        on: { click: onSelect(x) } },
        h("span.tk-ev__rail"), h("span.tk-ev__t", { text: x.t.goal }), h("span.tk-ev__time", { text: hm(x.h) }));
      return draggable(el, x);
    }));
    const slot = (e) => { const r = col.getBoundingClientRect(); return Math.max(H0, Math.min(H1 - 0.5, Math.round((H0 + (e.clientY - r.top) / HP) * 2) / 2)); };
    dropZone(col, (e) => { const hh = slot(e), at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(hh), hh % 1 ? 30 : 0).getTime();
      return { at, top: (Math.min(H1 - 1, hh) - H0) * HP + 1, label: `→ ${WD()[d.getDay()]} ${hm(hh)}` }; });
    col.addEventListener("dblclick", (e) => { if (!e.target.closest(".tk-ev")) composeAt(d, slot(e)); });
    return col;
  });
  const body = h("div.tk-wk__body", { vars: { "--n": days.length, "--hp": `${HP.toFixed(2)}px`, "--ghost-h": `${Math.max(10, HP - 2).toFixed(1)}px` } }, hours, cols,
    showNow ? [h("span.tk-now", { vars: { "--top": `${nowTop.toFixed(1)}px` } }), h("span.tk-now__l", { text: nowLabel(), vars: { "--top": `${nowTop.toFixed(1)}px` } })] : null);
  return [head, body];
}

function monthBody(bh) {
  const today = new Date(), mStart = monthStart(), g0 = addDays(mStart, -((mStart.getDay() + 6) % 7));
  const maxi = Math.max(0, Math.floor((bh / 6 - 30) / 22));
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(g0, i), items = dayItems(d), td = sameDay(d, today), inM = d.getMonth() === mStart.getMonth();
    const cell = h("div.tk-mo__cell", { cls: [td ? "is-today" : "", inM ? "" : "is-out"].join(" ") },
      h("div.tk-mo__top", null, S.W >= 760 ? wxMark(d, { lo: false }) || h("span") : h("span"), h("span.tk-mo__num", { text: String(d.getDate()) })),
      items.slice(0, maxi).map((x) => draggable(h("article.tk-chip", { cls: kcls(x), title: tip(x), on: { click: onSelect(x) } },
        h("span.tk-chip__dot"), h("span.tk-chip__t", { text: x.t.goal }), h("span.tk-chip__time", { text: hm(x.h) })), x)),
      maxi === 0 && items.length ? h("div.tk-mo__dots", { title: items.map((x) => `${hm(x.h)} ${x.t.goal}`).join("\n") }, items.map((x) => h("span.tk-mo__dot", { cls: kcls(x) }))) : null,
      maxi > 0 && items.length > maxi ? h("span.tk-mo__more", { text: t("tk.more", { n: items.length - maxi }) }) : null);
    dropZone(cell, () => { const keep = S.items.find((x) => x.id === S.drag);
      const hh = keep?.h ?? 9; return { at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(hh), Math.round((hh % 1) * 60)).getTime() }; });
    cell.addEventListener("dblclick", (e) => { if (!e.target.closest(".tk-chip")) composeAt(d, 9); });
    return cell;
  });
  return [h("div.tk-mo__head", null, WD_MON().map((w) => h("span", { text: w }))), h("div.tk-mo__body", null, cells)];
}

/** Split panel: mini month + agenda (prototype calMini / calAgenda). */
export function splitPanel(days) {
  const today = new Date(), base = S.view === "week" ? days[0] : monthStart();
  const mm = new Date(base.getFullYear(), base.getMonth() + S.miniD, 1), g = addDays(mm, -((mm.getDay() + 6) % 7));
  const dn = (d) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
  const all = dated();
  const mini = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(g, i), td = sameDay(d, today), inSpan = S.view === "week" && dn(d) >= dn(days[0]) && dn(d) <= dn(days[days.length - 1]);
    const has = all.some((x) => sameDay(x.date, d));
    return h("button.tk-mini__d", { cls: [td ? "is-today" : "", d.getMonth() === mm.getMonth() ? "" : "is-out", inSpan ? "is-span" : "", has && !td ? "has" : ""].join(" "),
      on: { click: () => { S.view = "week"; S.miniD = 0; S.off = Math.round((mon0(d) - mon0(today)) / (7 * 864e5)); emit(); } } },
      h("span.tk-mini__n", { text: String(d.getDate()) }), h("span.tk-mini__dot"));
  });
  const groups = [];
  for (let k = 0; k < 21 && groups.length < 4; k++) {
    const d = addDays(d0(today), k), items = dayItems(d);
    if (!items.length && k > 1) continue;
    groups.push(h("div.tk-ag__g", null,
      h("div.tk-ag__gh", null, h("span.tk-ag__gl", { cls: k === 0 ? "is-today" : "", text: k === 0 ? t("tk.today") : k === 1 ? t("tk.tomorrow") : WD()[d.getDay()] }),
        h("span.tk-ag__gd", { text: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` })),
      items.map((x) => draggable(h("div.tk-ag__it", { cls: kcls(x), title: tip(x), on: { click: () => select(x.id) } },
        h("span.tk-ag__t", null, h("span.tk-ag__sq"), h("span.tk-ag__goal", { text: x.t.goal })),
        h("span.tk-ag__m", { text: `${hm(x.h)} – ${pad(Math.floor(x.h + 1) % 24)}:${pad(Math.round((x.h % 1) * 60))} · ${label(x.k)}` })), x)),
      items.length ? null : h("div.tk-ag__empty", { text: t("tk.none.day") })));
  }
  return h("div.tk-split", null,
    h("div.tk-mini", null,
      h("div.tk-mini__h", null,
        h("button.tk-mini__nav", { "aria-label": t("tk.prevMonth"), text: "‹", on: { click: () => { S.miniD--; emit(); } } }),
        h("span.tk-mini__t", null, MONTHS()[mm.getMonth()], " ", h("span", { text: String(mm.getFullYear()) })),
        h("button.tk-mini__nav", { "aria-label": t("tk.nextMonth"), text: "›", on: { click: () => { S.miniD++; emit(); } } })),
      h("div.tk-mini__g", null, WD_MON().map((w) => h("span.tk-mini__wd", { text: w })), mini)),
    h("div.tk-ag", { "data-scroll": "1" }, groups));
}

/** Toolbar data + body for the ledger. */
/** Toolbar title and sub line of the week/month range (fallback when a style returns range: null). */
export function rangeOf() {
  const wk = S.view === "week", days = weekDays(), f = days[0], l = days[days.length - 1], MS = t("tk.monthsShort").split(","), ms = monthStart();
  const inRange = (a, b) => dated().filter((x) => x.date >= d0(a) && x.date < addDays(b, 1)).length;
  const range = wk ? `${f.getDate()}. ${MS[f.getMonth()]} – ${l.getDate()}. ${MS[l.getMonth()]} ${l.getFullYear()}` : `${MONTHS()[ms.getMonth()]} ${ms.getFullYear()}`;
  const sub = wk ? (days.length === 7 ? t("tk.weekSub", { w: isoWeek(f), n: inRange(f, l) }) : t("tk.narrowSub"))
    : t("tk.monthSub", { n: dated().filter((x) => x.date.getMonth() === ms.getMonth() && x.date.getFullYear() === ms.getFullYear()).length });
  return { range, sub };
}

export function ledger({ bw, bh }) {
  const wk = S.view === "week", days = weekDays(), { range, sub } = rangeOf();
  const box = h("div.tk-lg", { cls: wk ? "tk-lg--week" : "tk-lg--month" }, wk ? weekBody(days, bw, bh) : monthBody(bh));
  dndRoot(box);
  return {
    nav: true, range, sub, days,
    levels: [["week", t("tk.lv.week")], ["month", t("tk.lv.month")]].map(([v, lab]) => ({ label: lab, on: S.view === v, onClick: () => { S.view = v; S.off = 0; emit(); } })),
    prev: () => { S.off--; emit(); }, next: () => { S.off++; emit(); }, today: () => { S.off = 0; emit(); },
    canAgenda: wk && S.W >= 640,
    body: box,
  };
}

registerCalendarStyle({ id: "ledger", pro: false, render: ledger });
