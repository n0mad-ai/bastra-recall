// Lens drawings — the five canvas views of the prototype's memory-lenses.js
// (chronos · radiant · spiral · weave · halflife), fed with real memories.
// Differences to the sample data: Chronos dates by created (cyan) and updated
// (amber) like the prototype, the other lenses by the last update; links are
// the vault's own edges (written | derived).
import { t as tr, LANG } from "../i18n.js";
import { hash } from "./vault-data.js";
import { TC, ACC, AMB, INK, MUT } from "./chrome.js";

const RC = { linked: INK, derived: MUT };
const MONO = "'IBM Plex Mono', ui-monospace, monospace",
  SANS = "'IBM Plex Sans Condensed', system-ui, sans-serif";
const LOC = LANG === "de" ? "de-DE" : "en-GB";
const MON = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.UTC(2026, i, 1)).toLocaleDateString(LOC, { month: "short", timeZone: "UTC" }).replace(/\./g, "")
);
const MONL = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.UTC(2026, i, 1)).toLocaleDateString(LOC, { month: "long", timeZone: "UTC" }).toUpperCase()
);
const DAY = 864e5,
  DAYS = 364,
  WEEKS = 52,
  TAU = Math.PI * 2;
let NOW = Date.now();
export const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
const dateOf = (d) => new Date(NOW - d * DAY);
export const dstr = (d) =>
  dateOf(d).toLocaleDateString(LOC, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const isoWeek = (dt) => {
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const wd = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - wd);
  return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
};
const monthStarts = () => {
  const out = [];
  for (let d = DAYS - 1; d >= 0; d--) if (dateOf(d).getUTCDate() === 1) out.push(d);
  return out;
};

/** d = u = days since the memory was last updated, c = days since it was created (-1: unknown). */
export function prep(V) {
  NOW = Date.now();
  const day = (ms) => (Number.isFinite(ms) ? Math.floor((NOW - ms) / DAY) : -1);
  const items = V.map((m) => ({
    m,
    d: day(m.at),
    u: day(m.at),
    c: day(m.created),
    j: hash(m.id),
    j2: hash(m.id + "~"),
  })).filter((x) => x.d >= 0 && x.d < DAYS);
  const byId = new Map(items.map((x) => [x.m.id, x]));
  const ac = new Map();
  items.forEach((x) => ac.set(x.m.area, (ac.get(x.m.area) || 0) + 1));
  const areas = [...ac.entries()].sort((a, b) => b[1] - a[1]).map(([area, n]) => ({ area, n }));
  const maxRec = Math.max(1, ...items.map((x) => x.m.recalled));
  const pairs = [],
    seen = new Set();
  items.forEach((x) =>
    x.m.links.forEach((l) => {
      const b = byId.get(l.id);
      if (!b || b === x) return;
      const k = x.m.id < l.id ? x.m.id + "|" + l.id : l.id + "|" + x.m.id;
      if (seen.has(k)) return;
      seen.add(k);
      pairs.push({ a: x, b, rel: l.rel });
    })
  );
  return { items, byId, areas, maxRec, pairs, older: V.length - items.length };
}

function fit(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}
function tan(ctx, s, cx, cy, r, a) {
  ctx.save();
  ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  ctx.rotate(Math.sin(a) > 0.05 ? a - Math.PI / 2 : a + Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(s, 0, 0);
  ctx.restore();
}
function rad(ctx, s, cx, cy, r, a) {
  ctx.save();
  ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  if (Math.cos(a) < -0.001) {
    ctx.rotate(a + Math.PI);
    ctx.textAlign = "right";
  } else {
    ctx.rotate(a);
    ctx.textAlign = "left";
  }
  ctx.textBaseline = "middle";
  ctx.fillText(s, 0, 0);
  ctx.restore();
}
function avail(cx, cy, r, a, w, h, m = 12) {
  const x = cx + Math.cos(a) * r,
    y = cy + Math.sin(a) * r,
    c = Math.cos(a),
    s = Math.sin(a);
  const tx = c > 1e-3 ? (w - m - x) / c : c < -1e-3 ? (m - x) / c : 1e9,
    ty = s > 1e-3 ? (h - m - y) / s : s < -1e-3 ? (m - y) / s : 1e9;
  return Math.max(0, Math.min(tx, ty));
}
function legend(ctx, x, y, rows) {
  ctx.font = `10px ${MONO}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  rows.forEach(([c, label, shape], i) => {
    const yy = y + i * 16;
    ctx.fillStyle = c;
    ctx.strokeStyle = c;
    if (shape === "line") ctx.fillRect(x, yy - 0.5, 10, 1.5);
    else if (shape === "dot") {
      ctx.beginPath();
      ctx.arc(x + 5, yy, 2.6, 0, TAU);
      ctx.fill();
    } else ctx.fillRect(x + 1, yy - 4, 8, 8);
    ctx.fillStyle = MUT;
    ctx.fillText(label, x + 18, yy);
  });
}
const typeLegend = (P) => {
  const have = new Set(P.items.map((x) => x.m.cls));
  return ["decision", "rule", "convention", "fact", "note", "reference"]
    .filter((c) => have.has(c))
    .map((c) => [TC[c], tr(`vv.cls.${c}`), "dot"]);
};
const dimA = (g, x) => (g.o.focus && x.m.area !== g.o.focus ? 0.12 : 1);

// ── 1 · Chronos — a year as a dial: needles per day, week badges, dot bands per area ──
function chronos(g) {
  const { ctx, w, h, P, o, t, hov } = g;
  const cx = w / 2,
    cy = h / 2,
    R = Math.min(w, h) / 2 - 10;
  const GAP = 0.4,
    span = TAU - GAP,
    a0 = -Math.PI / 2 + GAP / 2;
  const angD = (d) => a0 + ((DAYS - 1 - d + 0.5) / DAYS) * span,
    reveal = a0 + span * t;
  const foc = o.focus;
  const bands = P.areas.slice(0, R > 280 ? 8 : R > 200 ? 6 : 4);
  const bt = R * 0.05,
    rIn = R - bands.length * bt,
    rWk = rIn - R * 0.045,
    mfs = Math.max(9, Math.min(11.5, R * 0.032)),
    rMo = rWk - Math.min(10, bt * 0.95) / 2 - mfs * 0.95,
    rN1 = rMo - mfs * 0.9,
    rN0 = R * 0.34;
  // dot bands, 3-day bins
  const BIN = 3,
    NB = Math.ceil(DAYS / BIN),
    bIdx = new Map(bands.map((b, i) => [b.area, i]));
  const per = bands.map(() => new Array(NB).fill(0));
  // Like the prototype, Chronos counts the memories created within the year.
  const yr = P.items.filter((x) => x.c >= 0 && x.c < DAYS);
  yr.forEach((x) => {
    const bi = bIdx.get(x.m.area);
    if (bi !== undefined) per[bi][Math.floor(x.c / BIN)]++;
  });
  const pmax = Math.max(1, ...per.flat());
  const binA = (k) => a0 + ((NB - 1 - k + 0.5) / NB) * span;
  bands.forEach((b, bi) => {
    const r = R - (bi + 0.5) * bt,
      hot = foc === b.area || (hov && hov.area === b.area) || o.hoverArea === b.area,
      dim = foc && foc !== b.area;
    const sp = (span * r) / NB,
      size = (c) => (c ? Math.min(bt * 0.42, sp * 0.44, 0.9 + Math.sqrt(c / pmax) * bt * 0.4) : 0.55);
    for (let k = 0; k < NB; k++) {
      const a = binA(k);
      if (a > reveal) continue;
      const c = per[bi][k],
        s = size(c);
      ctx.fillStyle = hot
        ? rgba(ACC, c ? 0.95 : 0.22)
        : rgba(INK, dim ? 0.05 : c ? 0.22 + 0.62 * Math.sqrt(c / pmax) : 0.07);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, s, 0, TAU);
      ctx.fill();
    }
    const fs = Math.max(8, Math.min(10, bt * 0.66));
    ctx.font = `${fs}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = hot ? ACC : rgba(MUT, dim ? 0.45 : 0.95);
    const label = fit(ctx, b.area, 2 * r * Math.sin(GAP / 2) * 0.9),
      labW = ctx.measureText(label).width;
    ctx.fillText(label, cx, cy - r);
    // Hit only what is visible: the band label in the gap and the band's
    // non-empty 3-day dots (empty bins are near-invisible specks).
    g.reg(
      (x, y) => {
        const dx = x - cx,
          dy = y - cy;
        if (Math.abs(dx) <= labW / 2 + 3 && Math.abs(dy + r) <= fs / 2 + 2) return true;
        if (Math.abs(Math.hypot(dx, dy) - r) >= bt / 2) return false;
        let aa = Math.atan2(dy, dx);
        while (aa < a0) aa += TAU;
        while (aa >= a0 + TAU) aa -= TAU;
        if (aa > reveal) return false;
        const k = Math.round(NB - 0.5 - ((aa - a0) / span) * NB);
        for (let j = k - 1; j <= k + 1; j++) {
          if (j < 0 || j >= NB || !per[bi][j]) continue;
          const aj = binA(j);
          if (
            Math.hypot(x - (cx + Math.cos(aj) * r), y - (cy + Math.sin(aj) * r)) <=
            Math.max(size(per[bi][j]) + 3, bt / 2)
          )
            return true;
        }
        return false;
      },
      {
        key: "a:" + b.area,
        area: b.area,
        title: b.area,
        sub: tr("vv.lens.bandSub", { n: b.n }),
        hint: tr("vv.lens.focusArea"),
      }
    );
  });
  // week badges
  const wsp = (span * rWk) / WEEKS,
    bw = Math.min(17, wsp * 0.8),
    bh = Math.min(10, bt * 0.95);
  for (let k = 0; k < WEEKS; k++) {
    const a = a0 + ((WEEKS - 1 - k + 0.5) / WEEKS) * span;
    if (a > reveal) continue;
    const x = cx + Math.cos(a) * rWk,
      y = cy + Math.sin(a) * rWk;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(a) > 0.05 ? a - Math.PI / 2 : a + Math.PI / 2);
    ctx.strokeStyle = k === 0 ? ACC : "rgba(126,164,210,.38)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1, bh - 1);
    if (bw >= 11) {
      ctx.font = `${Math.min(7.5, bh * 0.72)}px ${MONO}`;
      ctx.fillStyle = k === 0 ? ACC : rgba(MUT, 0.95);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(isoWeek(dateOf(k * 7 + 3))), 0, 0.5);
    }
    ctx.restore();
  }
  // months
  const ms = monthStarts();
  ctx.font = `600 ${mfs}px ${SANS}`;
  ctx.letterSpacing = "2px";
  ms.forEach((d, i) => {
    const a = angD(d);
    if (a > reveal) return;
    ctx.strokeStyle = "rgba(126,164,210,.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rN0, cy + Math.sin(a) * rN0);
    ctx.lineTo(cx + Math.cos(a) * (rWk - bh), cy + Math.sin(a) * (rWk - bh));
    ctx.stroke();
    const dEnd = i + 1 < ms.length ? ms[i + 1] : -1,
      am = angD((d + dEnd) / 2);
    if (am <= reveal && d - dEnd > 12) {
      ctx.fillStyle = INK;
      tan(ctx, MONL[dateOf(d).getUTCMonth()], cx, cy, rMo, am);
    }
  });
  ctx.letterSpacing = "0px";
  // needles
  const cr = new Array(DAYS).fill(0),
    up = new Array(DAYS).fill(0),
    lists = Array.from({ length: DAYS }, () => []);
  yr.forEach((x) => {
    if (foc && x.m.area !== foc) return;
    cr[x.c]++;
    lists[x.c].push(x);
    if (x.u !== x.c) up[x.u]++;
  });
  const pct = (arr, q) => {
    const s = arr.filter((v) => v > 0).sort((a, b) => a - b);
    return Math.max(1, s.length ? s[Math.floor((s.length - 1) * q)] : 1);
  };
  const cmax = pct(cr, 0.92),
    umax = pct(up, 0.92),
    LEN = rN1 - rN0;
  for (let d = 0; d < DAYS; d++) {
    const a = angD(d);
    if (a > reveal) continue;
    const ca = Math.cos(a),
      sa = Math.sin(a),
      L = cr[d] ? LEN * Math.min(0.86, 0.1 + 0.72 * Math.sqrt(cr[d] / cmax)) * t : 0,
      Lu = up[d] ? LEN * Math.min(0.14, 0.12 * Math.sqrt(up[d] / umax)) * t : 0;
    const isH = hov && hov.key === "d:" + d;
    ctx.strokeStyle = "rgba(126,164,210,.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + ca * (rN0 - 4), cy + sa * (rN0 - 4));
    ctx.lineTo(cx + ca * rN0, cy + sa * rN0);
    ctx.stroke();
    if (L) {
      ctx.strokeStyle = rgba(ACC, isH ? 1 : 0.5);
      ctx.lineWidth = isH ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + ca * rN0, cy + sa * rN0);
      ctx.lineTo(cx + ca * (rN0 + L), cy + sa * (rN0 + L));
      ctx.stroke();
    }
    if (Lu) {
      ctx.strokeStyle = rgba(AMB, isH ? 1 : 0.7);
      ctx.lineWidth = isH ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + ca * (rN0 + L + 1), cy + sa * (rN0 + L + 1));
      ctx.lineTo(cx + ca * (rN0 + L + 1 + Lu), cy + sa * (rN0 + L + 1 + Lu));
      ctx.stroke();
    }
    if (L || Lu) {
      const tr = rN0 + L + (Lu ? Lu + 1 : 0);
      ctx.fillStyle = Lu ? AMB : ACC;
      ctx.beginPath();
      ctx.arc(cx + ca * tr, cy + sa * tr, isH ? 2.6 : 1.4, 0, TAU);
      ctx.fill();
      g.pt(cx + ca * tr, cy + sa * tr, 5, { key: "d:" + d, day: d, items: lists[d], created: cr[d], updated: up[d] });
    }
  }
  // now marker
  const an = angD(0);
  ctx.strokeStyle = rgba(ACC, 0.7);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(an + 0.012) * (rN0 - 6), cy + Math.sin(an + 0.012) * (rN0 - 6));
  ctx.lineTo(cx + Math.cos(an + 0.012) * rIn, cy + Math.sin(an + 0.012) * rIn);
  ctx.stroke();
  // inner month ring + centre
  const rC = rN0 - Math.max(16, R * 0.06),
    mt = new Array(12).fill(0);
  yr.forEach((x) => {
    if (!foc || x.m.area === foc) mt[dateOf(x.c).getUTCMonth()]++;
  });
  ctx.strokeStyle = "rgba(126,164,210,.16)";
  ctx.beginPath();
  ctx.arc(cx, cy, rC + 10, 0, TAU);
  ctx.stroke();
  if (R > 190)
    ms.forEach((d, i) => {
      const dEnd = i + 1 < ms.length ? ms[i + 1] : -1;
      if (d - dEnd < 12) return;
      const a = angD((d + dEnd) / 2),
        mo = dateOf(d).getUTCMonth();
      ctx.font = `${Math.min(9, R * 0.026)}px ${MONO}`;
      ctx.fillStyle = MUT;
      tan(ctx, MON[mo].toUpperCase(), cx, cy, rC + 2, a);
      ctx.fillStyle = ACC;
      tan(ctx, String(mt[mo]), cx, cy, rC - 10, a);
    });
  const tot = cr.reduce((a, b) => a + b, 0),
    upd = up.reduce((a, b) => a + b, 0),
    cs = Math.max(16, Math.min(R * 0.1, rC * 0.42));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.max(8, R * 0.024)}px ${MONO}`;
  ctx.letterSpacing = "2px";
  ctx.fillStyle = MUT;
  ctx.fillText(fit(ctx, foc ? foc.toUpperCase() : tr("vv.lens.months12"), rC * 1.7), cx, cy - cs * 1.15);
  ctx.letterSpacing = "0px";
  ctx.font = `300 ${cs}px ${MONO}`;
  ctx.fillStyle = ACC;
  ctx.fillText(fmt(tot * t), cx, cy - cs * 0.3);
  ctx.font = `${Math.max(8, R * 0.022)}px ${MONO}`;
  ctx.fillStyle = MUT;
  ctx.fillText(tr("vv.lens.memories"), cx, cy + cs * 0.32);
  ctx.font = `300 ${cs * 0.62}px ${MONO}`;
  ctx.fillStyle = AMB;
  ctx.fillText(fmt(upd * t), cx, cy + cs * 0.86);
  ctx.font = `${Math.max(8, R * 0.022)}px ${MONO}`;
  ctx.fillStyle = MUT;
  ctx.fillText(tr("vv.lens.updates"), cx, cy + cs * 1.32);
  if (w - 2 * R > 260)
    legend(ctx, 16, 20, [
      [ACC, tr("vv.lens.createdDay"), "line"],
      [AMB, tr("vv.lens.updatedDay"), "line"],
      [rgba(INK, 0.7), tr("vv.lens.byArea"), "dot"],
      ["rgba(126,164,210,.6)", tr("vv.lens.week"), "box"],
    ]);
}

// ── 2 · Radiant — every memory a ray from the core, the most recalled named on the rim ──
function radiant(g) {
  const { ctx, w, h, P, o, t, hov } = g;
  const cx = w / 2,
    cy = h / 2,
    R = Math.max(80, Math.min(h / 2 - 34, w / 2 - 170)),
    Lm = 150;
  const ang = (x) => -Math.PI / 2 + ((DAYS - 1 - x.d - x.j * 0.98 + 1) / DAYS) * TAU,
    reveal = -Math.PI / 2 + TAU * t;
  const rc = Math.max(26, R * 0.15),
    rS0 = rc * 1.55,
    rS1 = R * 0.78,
    rMo = R - 13;
  for (let i = 1; i <= 6; i++) {
    ctx.strokeStyle = `rgba(126,164,210,${i === 6 ? 0.16 : 0.06})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rS0 + ((rS1 - rS0) * i) / 6, 0, TAU);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(126,164,210,.3)";
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.stroke();
  for (let d = 0; d < DAYS; d++) {
    const a = -Math.PI / 2 + ((DAYS - d) / DAYS) * TAU;
    if (a > reveal) continue;
    const L = dateOf(d).getUTCDay() === 1 ? 6 : 2.5;
    ctx.strokeStyle = "rgba(126,164,210,.35)";
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.lineTo(cx + Math.cos(a) * (R - L), cy + Math.sin(a) * (R - L));
    ctx.stroke();
  }
  const ms = monthStarts();
  ctx.font = `600 ${Math.max(8.5, Math.min(10.5, R * 0.036))}px ${SANS}`;
  ctx.letterSpacing = "1.5px";
  ms.forEach((d, i) => {
    const a = -Math.PI / 2 + ((DAYS - d) / DAYS) * TAU;
    ctx.strokeStyle = "rgba(126,164,210,.12)";
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rS0, cy + Math.sin(a) * rS0);
    ctx.lineTo(cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22));
    ctx.stroke();
    const dEnd = i + 1 < ms.length ? ms[i + 1] : -1;
    if (d - dEnd < 12) return;
    const am = -Math.PI / 2 + ((DAYS - (d + dEnd) / 2) / DAYS) * TAU;
    if (am > reveal) return;
    ctx.fillStyle = INK;
    tan(ctx, MONL[dateOf(d).getUTCMonth()], cx, cy, rMo, am);
  });
  ctx.letterSpacing = "0px";
  // core
  const gr = ctx.createRadialGradient(cx - rc * 0.3, cy - rc * 0.3, rc * 0.1, cx, cy, rc);
  gr.addColorStop(0, "#1b3150");
  gr.addColorStop(1, "#070d18");
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(cx, cy, rc, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(ACC, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();
  for (let i = 0; i < 320; i++) {
    const a = hash("h" + i) * TAU,
      rr = rc * (1.06 + Math.pow(hash("r" + i), 1.6) * 0.42);
    ctx.fillStyle = rgba(AMB, 0.15 + hash("a" + i) * 0.55);
    ctx.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1, 1);
  }
  ctx.font = `300 ${Math.max(13, rc * 0.46)}px ${MONO}`;
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const shown = P.items.filter((x) => !o.focus || x.m.area === o.focus);
  ctx.fillText(fmt(shown.length * t), cx, cy - rc * 0.12);
  ctx.font = `${Math.max(7, rc * 0.16)}px ${MONO}`;
  ctx.fillStyle = MUT;
  ctx.fillText(tr("vv.lens.memories"), cx, cy + rc * 0.38);
  // dust band
  P.items.forEach((x) => {
    const a = ang(x);
    if (a > reveal) return;
    const rr = rS1 + (R - 24 - rS1) * x.j2;
    ctx.fillStyle = rgba(INK, 0.28 * dimA(g, x));
    ctx.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1, 1);
  });
  // rays
  const hid = hov && hov.m ? hov.m.id : null,
    linked = new Set(hid ? hov.m.links.map((l) => l.id) : []);
  const end = new Map();
  P.items.forEach((x) => {
    const a = ang(x);
    if (a > reveal) return;
    const f = Math.sqrt(x.m.recalled / P.maxRec),
      r = rS0 + (rS1 - rS0) * (0.1 + 0.9 * f) * t,
      ca = Math.cos(a),
      sa = Math.sin(a),
      dm = dimA(g, x),
      c = TC[x.m.cls] || INK;
    const isH = x.m.id === hid || linked.has(x.m.id);
    ctx.strokeStyle = rgba(c, (isH ? 0.95 : 0.26) * dm);
    ctx.lineWidth = isH ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + ca * rS0, cy + sa * rS0);
    ctx.lineTo(cx + ca * r, cy + sa * r);
    ctx.stroke();
    const dr = 1.2 + Math.min(3.4, x.m.acted * 0.22);
    ctx.fillStyle = rgba(c, (isH ? 1 : 0.85) * dm);
    ctx.beginPath();
    ctx.arc(cx + ca * r, cy + sa * r, isH ? dr + 1.2 : dr, 0, TAU);
    ctx.fill();
    end.set(x.m.id, [cx + ca * r, cy + sa * r, a, r]);
    if (dm > 0.5) g.pt(cx + ca * r, cy + sa * r, Math.max(4, dr + 2), { key: "m:" + x.m.id, m: x.m, d: x.d });
  });
  if (hid && end.has(hid)) {
    const [x0, y0] = end.get(hid);
    ctx.lineWidth = 1;
    hov.m.links.forEach((l) => {
      const e = end.get(l.id);
      if (!e) return;
      ctx.strokeStyle = rgba(RC[l.rel] || MUT, 0.85);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, e[0], e[1]);
      ctx.stroke();
    });
  }
  // rim labels
  const fs = Math.max(8.5, Math.min(10.5, R * 0.034));
  ctx.font = `${fs}px ${SANS}`;
  const minGap = (fs + 2.5) / R,
    cand = P.items
      .filter((x) => dimA(g, x) > 0.5 && x.m.recalled > 0)
      .sort((a, b) => b.m.recalled - a.m.recalled)
      .slice(0, 90)
      .sort((a, b) => ang(a) - ang(b));
  const taken = [];
  cand.forEach((x) => {
    const a = ang(x);
    if (avail(cx, cy, R + 8, a, w, h) < 44) return;
    if (taken.some((b) => Math.abs(b - a) < minGap || Math.abs(b - a) > TAU - minGap)) return;
    taken.push(a);
    x._lab = true;
  });
  cand.forEach((x) => {
    if (!x._lab) return;
    delete x._lab;
    const e = end.get(x.m.id);
    if (!e) return;
    const [ex, ey, a] = e;
    if (a > reveal - 0.05) return;
    ctx.strokeStyle = "rgba(126,164,210,.28)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(cx + Math.cos(a) * (R + 3), cy + Math.sin(a) * (R + 3));
    ctx.stroke();
    ctx.setLineDash([]);
    const room = avail(cx, cy, R + 8, a, w, h);
    if (room < 44) return;
    const isH = x.m.id === hid;
    ctx.fillStyle = isH ? ACC : rgba(INK, 0.82);
    rad(ctx, fit(ctx, x.m.title, Math.min(Lm, room)), cx, cy, R + 8, a);
  });
  if (cx - R - 160 > 170)
    legend(ctx, 16, 20, typeLegend(P).concat([["rgba(126,164,210,.6)", tr("vv.lens.rayLen"), "line"]]));
}

// ── 3 · Spiral — one turn per calendar month, oldest at the centre, months stacked on one axis ──
function spiral(g) {
  const { ctx, w, h, P, t, hov } = g;
  const cx = w / 2,
    cy = h / 2,
    R = Math.min(w, h) / 2 - 26;
  if (R < 80) return;
  const old = dateOf(DAYS - 1),
    base = old.getUTCFullYear() * 12 + old.getUTCMonth(),
    nowD = dateOf(0),
    TURNS = nowD.getUTCFullYear() * 12 + nowD.getUTCMonth() - base + 1;
  const r0 = R * 0.12,
    step = (R - r0) / TURNS;
  const pos = (dd) => {
    const dt = dateOf(dd),
      mi = dt.getUTCFullYear() * 12 + dt.getUTCMonth() - base,
      dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    const f = (dt.getUTCDate() - 1 + (dt.getUTCHours() + dt.getUTCMinutes() / 60) / 24) / dim;
    return [-Math.PI / 2 + f * TAU, r0 + step * (mi + f)];
  };
  const lim = DAYS * (1 - t);
  ctx.strokeStyle = "rgba(126,164,210,.34)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 1600; k++) {
    const dd = DAYS - 1 - (k / 1600) * (DAYS - 1);
    if (dd < lim) break;
    const [th, r] = pos(dd);
    const x = cx + Math.cos(th) * r,
      y = cy + Math.sin(th) * r;
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  // month axis (12 o'clock) + day-of-month scale outside
  ctx.strokeStyle = "rgba(126,164,210,.35)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - r0 + 4);
  ctx.lineTo(cx, cy - R - 6);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = MUT;
  ctx.font = `9px ${MONO}`;
  [8, 15, 22].forEach((dm) => {
    const a = -Math.PI / 2 + ((dm - 1) / 30.4) * TAU;
    ctx.strokeStyle = "rgba(126,164,210,.25)";
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (R + 2), cy + Math.sin(a) * (R + 2));
    ctx.lineTo(cx + Math.cos(a) * (R + 7), cy + Math.sin(a) * (R + 7));
    ctx.stroke();
    ctx.fillText(String(dm), cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16));
  });
  const hid = hov && hov.m ? hov.m.id : null,
    P2 = new Map();
  P.items.forEach((x) => {
    const dd = x.d + x.j * 0.98;
    if (dd < lim) return;
    const [th, rb] = pos(dd),
      r = rb + (x.j2 - 0.5) * step * 0.34;
    P2.set(x.m.id, [cx + Math.cos(th) * r, cy + Math.sin(th) * r]);
  });
  if (hid && P2.has(hid)) {
    const [x0, y0] = P2.get(hid);
    hov.m.links.forEach((l) => {
      const e = P2.get(l.id);
      if (!e) return;
      ctx.strokeStyle = rgba(RC[l.rel] || MUT, 0.9);
      ctx.lineWidth = 1.2;
      const mx = (x0 + e[0]) / 2,
        my = (y0 + e[1]) / 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(mx + (cx - mx) * 0.35, my + (cy - my) * 0.35, e[0], e[1]);
      ctx.stroke();
    });
  }
  const lk = new Set(hid ? hov.m.links.map((l) => l.id) : []);
  P.items.forEach((x) => {
    const p = P2.get(x.m.id);
    if (!p) return;
    const dm = dimA(g, x),
      c = TC[x.m.cls] || INK,
      isH = x.m.id === hid || lk.has(x.m.id);
    const r = Math.min(step * 0.26, 1 + Math.sqrt(x.m.recalled) * 0.42);
    if (x.m.mode === "reflex") {
      ctx.strokeStyle = rgba(AMB, 0.9 * dm);
      ctx.lineWidth = 1;
      ctx.strokeRect(p[0] - r - 2, p[1] - r - 2, 2 * r + 4, 2 * r + 4);
    }
    ctx.fillStyle = rgba(c, (isH ? 1 : 0.82) * dm);
    ctx.beginPath();
    ctx.arc(p[0], p[1], isH ? r + 1.5 : r, 0, TAU);
    ctx.fill();
    if (dm > 0.5) g.pt(p[0], p[1], Math.max(4, r + 2), { key: "m:" + x.m.id, m: x.m, d: x.d });
  });
  const fs = Math.max(8, Math.min(9.5, step * 0.62));
  ctx.font = `${fs}px ${MONO}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let mi = 0; mi < TURNS; mi++) {
    const r = r0 + step * (mi + 0.5),
      mo = (base + mi) % 12,
      cur = mi === TURNS - 1;
    if (cy - r < 8) continue;
    const s = MON[mo].toUpperCase() + (mo === 0 || mi === 0 ? " " + String(Math.floor((base + mi) / 12)).slice(2) : ""),
      tw = ctx.measureText(s).width;
    ctx.fillStyle = "rgba(6,10,19,.88)";
    ctx.fillRect(cx - tw - 8, cy - r - fs * 0.6, tw + 6, fs * 1.2);
    ctx.fillStyle = cur ? ACC : MUT;
    ctx.fillText(
      MON[mo].toUpperCase() + (mo === 0 || mi === 0 ? " " + String(Math.floor((base + mi) / 12)).slice(2) : ""),
      cx - 5,
      cy - r
    );
  }
  if (t > 0.98) {
    const [th, rN] = pos(0),
      nx = cx + Math.cos(th) * rN,
      ny = cy + Math.sin(th) * rN;
    ctx.strokeStyle = ACC;
    ctx.lineWidth = 1;
    ctx.strokeRect(nx - 4.5, ny - 4.5, 9, 9);
    ctx.fillStyle = ACC;
    ctx.font = `600 9.5px ${MONO}`;
    ctx.letterSpacing = "2px";
    ctx.textAlign = Math.cos(th) >= 0 ? "left" : "right";
    ctx.fillText(tr("vv.lens.now"), nx + (Math.cos(th) >= 0 ? 10 : -10), ny);
    ctx.letterSpacing = "0px";
  }
  if (cx - R > 230) legend(ctx, 16, 20, typeLegend(P).concat([["rgba(126,164,210,.6)", tr("vv.lens.turn"), "line"]]));
}

// ── 4 · Strata — one ridge per area across the year ──
function weave(g) {
  const { ctx, w, h, P, o, t, hov } = g;
  const cx = w / 2,
    cy = h / 2,
    R = Math.max(80, Math.min(h / 2 - 30, w / 2 - 170)),
    Lm = 160;
  const GAPA = 0.012,
    n = P.areas.length,
    total = P.items.length,
    avA = TAU - GAPA * n;
  const arc = new Map();
  let a = -Math.PI / 2;
  P.areas.forEach((ar) => {
    const sp = (avA * ar.n) / total;
    arc.set(ar.area, [a, a + sp]);
    a += sp + GAPA;
  });
  const order = new Map();
  P.areas.forEach((ar) => {
    const list = P.items
      .filter((x) => x.m.area === ar.area)
      .sort((p, q) => p.m.cls.localeCompare(q.m.cls) || p.d - q.d);
    list.forEach((x, i) => order.set(x.m.id, [ar.area, (i + 0.5) / list.length]));
  });
  const angOf = (id) => {
    const [ar, f] = order.get(id);
    const [a0, a1] = arc.get(ar);
    return a0 + (a1 - a0) * f;
  };
  const hArea = (hov && hov.area) || o.hoverArea || null,
    hId = hov && hov.m ? hov.m.id : null,
    foc = o.focus;
  const rT = R - 14;
  // threads
  ctx.globalCompositeOperation = "lighter";
  const prog = Math.floor(P.pairs.length * t);
  for (let i = 0; i < prog; i++) {
    const p = P.pairs[i],
      A1 = angOf(p.a.m.id),
      A2 = angOf(p.b.m.id);
    const inv =
      (hId && (p.a.m.id === hId || p.b.m.id === hId)) ||
      (hArea && (p.a.m.area === hArea || p.b.m.area === hArea)) ||
      (foc && (p.a.m.area === foc || p.b.m.area === foc));
    const any = hId || hArea || foc;
    const x1 = cx + Math.cos(A1) * rT,
      y1 = cy + Math.sin(A1) * rT,
      x2 = cx + Math.cos(A2) * rT,
      y2 = cy + Math.sin(A2) * rT,
      mx = (x1 + x2) / 2,
      my = (y1 + y2) / 2;
    ctx.strokeStyle = rgba(
      RC[p.rel] || MUT,
      inv ? (hId ? 0.75 : 0.22) : any ? 0.015 : p.a.m.area === p.b.m.area ? 0.035 : 0.075
    );
    ctx.lineWidth = inv && hId ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx + (mx - cx) * 0.12, cy + (my - cy) * 0.12, x2, y2);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  // area arcs + memory ticks + labels
  const fs = Math.max(9, Math.min(11, R * 0.038));
  P.areas.forEach((ar) => {
    const [a0, a1] = arc.get(ar.area),
      hot = hArea === ar.area || foc === ar.area,
      dim = foc && foc !== ar.area;
    ctx.strokeStyle = hot ? ACC : g.o.areaColor ? g.o.areaColor(ar.area, dim ? 0.25 : 0.85) : rgba(INK, 0.6);
    ctx.lineWidth = 8;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.arc(cx, cy, R + 4, a0, a0 + (a1 - a0) * t);
    ctx.stroke();
    let lab = null; // drawn label: angle and radial length
    if ((a1 - a0) * R >= fs + 2) {
      ctx.font = `${fs}px ${MONO}`;
      const need = Math.min(Lm, ctx.measureText(`${ar.area} ${ar.n}`).width + 4);
      let best = (a0 + a1) / 2,
        bestRoom = avail(cx, cy, R + 14, best, w, h);
      const pad = Math.min((a1 - a0) / 2, (fs * 0.7) / R);
      if (bestRoom < need)
        for (let k = 0; k <= 16; k++) {
          const aa = a0 + pad + ((a1 - a0 - 2 * pad) * k) / 16,
            rm = avail(cx, cy, R + 14, aa, w, h);
          if (rm > bestRoom) {
            bestRoom = rm;
            best = aa;
          }
        }
      if (bestRoom >= 40) {
        const s = fit(ctx, `${ar.area} ${ar.n}`, Math.min(Lm, bestRoom));
        ctx.fillStyle = hot ? ACC : rgba(INK, dim ? 0.35 : 0.9);
        rad(ctx, s, cx, cy, R + 14, best);
        lab = { a: best, len: ctx.measureText(s).width };
      }
    }
    // Hit only what is drawn: the area arc (R..R+8) and its radial label.
    g.reg(
      (x, y) => {
        const rr = Math.hypot(x - cx, y - cy);
        if (rr < R - 2) return false;
        let aa = Math.atan2(y - cy, x - cx);
        while (aa < -Math.PI / 2) aa += TAU;
        while (aa > -Math.PI / 2 + TAU) aa -= TAU;
        if (rr <= R + 10) return aa >= a0 && aa <= a1;
        if (!lab || rr < R + 10 || rr > R + 16 + lab.len) return false;
        let da = Math.abs(aa - lab.a);
        if (da > Math.PI) da = TAU - da;
        return da * rr <= fs * 0.7 + 2;
      },
      {
        key: "a:" + ar.area,
        area: ar.area,
        title: ar.area,
        sub: tr("vv.lens.weaveSub", {
          n: ar.n,
          l: P.pairs.filter((p) => p.a.m.area === ar.area || p.b.m.area === ar.area).length,
        }),
        hint: tr("vv.lens.focusArea"),
      }
    );
  });
  P.items.forEach((x) => {
    const aa = angOf(x.m.id),
      c = TC[x.m.cls] || INK,
      isH = x.m.id === hId,
      dm = dimA(g, x);
    ctx.strokeStyle = rgba(c, (isH ? 1 : 0.75) * dm);
    ctx.lineWidth = isH ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(aa) * (R - 2), cy + Math.sin(aa) * (R - 2));
    ctx.lineTo(cx + Math.cos(aa) * (R - (isH ? 12 : 8)), cy + Math.sin(aa) * (R - (isH ? 12 : 8)));
    ctx.stroke();
    if (dm > 0.5)
      g.pt(cx + Math.cos(aa) * (R - 5), cy + Math.sin(aa) * (R - 5), 3, { key: "m:" + x.m.id, m: x.m, d: x.d });
  });
  const rD = Math.max(30, R * 0.2);
  ctx.fillStyle = "rgba(6,10,19,.92)";
  ctx.beginPath();
  ctx.arc(cx, cy, rD, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(126,164,210,.3)";
  ctx.lineWidth = 1;
  ctx.stroke();
  const ln = foc ? P.pairs.filter((p) => p.a.m.area === foc || p.b.m.area === foc).length : P.pairs.length;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `300 ${Math.max(14, rD * 0.5)}px ${MONO}`;
  ctx.fillStyle = ACC;
  ctx.fillText(fmt(ln * t), cx, cy - rD * 0.1);
  ctx.font = `${Math.max(7.5, rD * 0.17)}px ${MONO}`;
  ctx.fillStyle = MUT;
  ctx.fillText(tr("vv.lens.links"), cx, cy + rD * 0.38);
  if (cx - R - 160 > 130)
    legend(
      ctx,
      16,
      20,
      Object.entries(RC)
        .filter(([k]) => P.pairs.some((p) => p.rel === k))
        .map(([k, c]) => [c, tr(`vv.rel.${k}`), "line"])
    );
}

// ── halflife: distance from the core = days since last touch (log), angle = area; memories drift outward and fade
function halflife(g) {
  const { ctx, w, h, P, o, t, hov, pt, reg } = g;
  const cx = w / 2,
    cy = h / 2,
    R = Math.max(90, Math.min(h / 2 - 36, w / 2 - 70)),
    rc = Math.max(22, R * 0.12);
  const L1 = Math.log(1 + DAYS),
    rOf = (u) => rc + (R - rc) * (Math.log(1 + Math.max(0, u)) / L1);
  const areas = o.focus ? P.areas.filter((a) => a.area === o.focus) : P.areas;
  const n = areas.length,
    GAPA = n > 1 ? 0.035 : 0,
    tot = areas.reduce((s, a) => s + a.n, 0),
    avA = TAU - GAPA * n;
  let a0 = -Math.PI / 2;
  const sec = new Map();
  areas.forEach((ar) => {
    const sp = (avA * ar.n) / tot;
    sec.set(ar.area, [a0, a0 + sp]);
    a0 += sp + GAPA;
  });
  const rings = [
    [0, tr("vv.lens.today")],
    [7, tr("vv.lens.week1")],
    [30, tr("vv.lens.month1")],
    [90, tr("vv.lens.month3")],
    [DAYS, tr("vv.lens.year1")],
  ];
  rings.forEach(([d, lab], i) => {
    const r = rOf(d) * (0.4 + 0.6 * t);
    ctx.strokeStyle = i === rings.length - 1 ? "rgba(126,164,210,.3)" : "rgba(126,164,210,.13)";
    ctx.setLineDash(i && i < rings.length - 1 ? [2, 4] : []);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    if (i) {
      ctx.font = "9.5px " + MONO;
      ctx.letterSpacing = "1px";
      const tw = ctx.measureText(lab).width;
      ctx.fillStyle = "rgba(6,10,19,.9)";
      ctx.fillRect(cx - tw / 2 - 4, cy - r - 6, tw + 8, 12);
      ctx.fillStyle = MUT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(lab, cx, cy - r);
      ctx.letterSpacing = "0px";
    }
  });
  const hid = hov && hov.m ? hov.m.id : null,
    hArea = hov && hov.area ? hov.area : hid ? hov.m.area : o.hoverArea || null;
  areas.forEach((ar) => {
    const [s0, s1] = sec.get(ar.area),
      on = !hArea || hArea === ar.area,
      ac = o.areaColor ? o.areaColor(ar.area, 1) : ACC;
    ctx.strokeStyle = ac;
    ctx.globalAlpha = on ? 0.9 : 0.3;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 7, s0, s0 + (s1 - s0) * t);
    ctx.stroke();
    ctx.globalAlpha = 1;
    let labA = 0; // half the label's angular width (0: no label)
    if ((s1 - s0) * R > 34) {
      ctx.font = "600 9.5px " + SANS;
      ctx.letterSpacing = "1.2px";
      ctx.fillStyle = on ? INK : MUT;
      const am = (s0 + s1) / 2,
        s = fit(ctx, ar.area.toUpperCase(), Math.max(24, (s1 - s0) * (R + 18) - 10));
      tan(ctx, s, cx, cy, R + 18, am);
      labA = (ctx.measureText(s).width / 2 + 4) / (R + 18);
      ctx.letterSpacing = "0px";
    }
    // Hit only what is drawn: the sector arc (R+7) and the label above its middle.
    reg(
      (x, y) => {
        const d = Math.hypot(x - cx, y - cy);
        if (d < R + 2 || d > R + 26) return false;
        let a = Math.atan2(y - cy, x - cx);
        while (a < s0) a += TAU;
        if (a > s1) return false;
        return d <= R + 12 || Math.abs(a - (s0 + s1) / 2) <= labA;
      },
      {
        key: "a:" + ar.area,
        area: ar.area,
        title: ar.area,
        sub: tr("vv.lens.halfSub", { n: ar.n, f: P.items.filter((x) => x.m.area === ar.area && x.u <= 7).length }),
        hint: tr("vv.lens.focusArea"),
      }
    );
  });
  const linked = new Set();
  if (hid) {
    const x = P.byId.get(hid);
    x && x.m.links.forEach((l) => linked.add(l.id));
  }
  const pos = new Map(),
    shown = P.items.filter((x) => sec.has(x.m.area));
  shown.forEach((x) => {
    const [s0, s1] = sec.get(x.m.area),
      a = s0 + 0.004 + (s1 - s0 - 0.008) * x.j,
      nr = Math.log(1 + x.u) / L1;
    if (nr > t * 1.05) return;
    const r = rOf(x.u) + (x.j2 - 0.5) * 4,
      px = cx + Math.cos(a) * r,
      py = cy + Math.sin(a) * r,
      sz = 1.3 + Math.sqrt(x.m.recalled / P.maxRec) * 4.2;
    pos.set(x.m.id, [px, py]);
    const isH = hid === x.m.id,
      isL = linked.has(x.m.id),
      dim = hArea && hArea !== x.m.area && !isL ? 0.2 : 1,
      fade = 1 - nr * 0.62,
      col = TC[x.m.cls] || INK;
    if (x.u <= 1 && !hArea) {
      ctx.fillStyle = rgba(col, 0.18);
      ctx.beginPath();
      ctx.arc(px, py, sz + 3.5, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = rgba(col, fade * dim);
    ctx.beginPath();
    ctx.arc(px, py, sz, 0, TAU);
    ctx.fill();
    if (isH || isL) {
      ctx.strokeStyle = isH ? INK : ACC;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(px, py, sz + 3, 0, TAU);
      ctx.stroke();
    }
    pt(px, py, Math.max(4, sz + 1.5), { key: x.m.id, m: x.m, d: x.d });
  });
  if (hid && pos.has(hid)) {
    const [hx, hy] = pos.get(hid),
      x = P.byId.get(hid);
    ctx.strokeStyle = rgba(ACC, 0.35);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.setLineDash([]);
    x.m.links.forEach((l) => {
      const b = pos.get(l.id);
      if (!b) return;
      ctx.strokeStyle = rgba(RC[l.rel] || ACC, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.quadraticCurveTo(cx + (hx + b[0] - 2 * cx) * 0.25, cy + (hy + b[1] - 2 * cy) * 0.25, b[0], b[1]);
      ctx.stroke();
    });
  }
  const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rc);
  gr.addColorStop(0, "#16314a");
  gr.addColorStop(1, "#070d18");
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(cx, cy, rc, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(ACC, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();
  const fresh = shown.filter((x) => x.u <= 7).length;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ACC;
  ctx.font = "300 " + Math.max(13, rc * 0.62) + "px " + MONO;
  ctx.fillText(fmt(fresh * t), cx, cy - rc * 0.12);
  ctx.fillStyle = MUT;
  ctx.font = "8.5px " + MONO;
  ctx.letterSpacing = "1px";
  ctx.fillText(tr("vv.lens.fresh"), cx, cy + rc * 0.42);
  ctx.letterSpacing = "0px";
}

export const VIEWS = { chronos, radiant, spiral, halflife, weave };
