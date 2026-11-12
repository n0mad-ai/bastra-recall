// Ring geometry — buildRing() from the prototype's ring-v8.js, fed with real
// areas and memories instead of RAW. Every segment is at least as wide as its
// full label; the wheel grows until all labels fit on one track.
import { hash } from "./vault-data.js";

export const SMALL_KEY = "__small";
// An area gets its own segment from 2 % of the counted memories on (the
// prototype's fixed 12 is ~2 % of its 559). Rule areas never go to "small".
const SMALL_SHARE = 0.02;
export const TAU = Math.PI * 2;

/**
 * @param {{ areas: {key:string,count:number,meta:boolean}[], mems: {id:string,area:string}[], ghosts: object[] }} v
 * @param {(n:number) => string} smallLabel
 */
export function buildRing(v, smallLabel) {
  const R0 = 96, GAP = 0.022;
  const byArea = new Map();
  for (const m of v.mems) { if (!byArea.has(m.area)) byArea.set(m.area, []); byArea.get(m.area).push(m); }
  const RAW = v.areas.map((a) => [a.key, a.count]);
  const META = new Set(v.areas.filter((a) => a.meta).map((a) => a.key));
  const meta = RAW.filter(([k]) => META.has(k));
  const rest = RAW.filter(([k]) => !META.has(k));
  const smallMin = RAW.reduce((sum, [, c]) => sum + c, 0) * SMALL_SHARE;
  const small = rest.filter(([, c]) => c < smallMin);
  const content = rest.filter(([, c]) => c >= smallMin).map(([k, c]) => ({ key: k, count: c, members: [[k, c]] }));
  if (small.length) content.push({ key: SMALL_KEY, label: smallLabel(small.length), count: small.reduce((s, [, c]) => s + c, 0), members: small });
  const mc = document.createElement("canvas").getContext("2d");
  const labelArc = (txt, c) => {
    mc.font = "700 10.5px 'IBM Plex Sans Condensed', 'Avenir Next', system-ui, sans-serif";
    const a = mc.measureText(txt.toUpperCase()).width + txt.length * 1.3;
    mc.font = "400 9.5px 'IBM Plex Mono', ui-monospace, monospace";
    const b = mc.measureText(String(c)).width + String(c).length * 0.4;
    return a + 6 + b;
  };
  const nodesFor = (members) => members.flatMap(([k]) => (byArea.get(k) || []).map((m) => ({ k, id: m.id, r: 1.5 + hash(m.id) * 2.3 }))).sort((a, b) => a.r - b.r);

  function pack(nodes, a0, span, startR) {
    let i = 0, rowInner = startR;
    const out = [];
    while (i < nodes.length) {
      const scale = Math.min(0.6 + (rowInner - R0) / 140, 1);
      const budget = span * rowInner;
      const row = []; let used = 0, rowMax = 0;
      while (i < nodes.length) {
        const er = Math.min(nodes[i].r * scale, (budget - 4) / 2);
        const cost = er * 2 + 3.2;
        if (row.length && used + cost > budget) break;
        row.push({ ...nodes[i], er }); used += cost; rowMax = Math.max(rowMax, er); i++;
      }
      const r = rowInner + rowMax;
      let a = a0 + Math.max((span - used / r) / 2, 0);
      for (const n of row) { const sh = (n.er * 2 + 3.2) / r; const na = a + sh / 2; out.push({ x: Math.cos(na) * r, y: Math.sin(na) * r, r: n.er, k: n.k, id: n.id }); a += sh; }
      rowInner = r + rowMax + 2.6;
    }
    return { pts: out, outer: rowInner };
  }

  const BAND = 30, PADA = 8;
  function allocate(Rt, usable) {
    const w = content.map((s) => Math.sqrt(s.count));
    const need = content.map((s) => (labelArc(s.label ?? s.key, s.count) + PADA) / Rt);
    const ws = w.reduce((s, x) => s + x, 0);
    let spans = w.map((x) => (x / ws) * usable);
    for (let it = 0; it < 10; it++) {
      const fixed = spans.map((s, i) => need[i] >= s);
      const fSum = need.reduce((s, n, i) => s + (fixed[i] ? n : 0), 0);
      const freeW = w.reduce((s, x, i) => s + (fixed[i] ? 0 : x), 0) || 1;
      spans = spans.map((_, i) => (fixed[i] ? need[i] : (w[i] / freeW) * (usable - fSum)));
    }
    return { spans, needSum: need.reduce((a, b) => a + b, 0) };
  }
  const usable = TAU - GAP * content.length;
  let Rb = 150, segs = [];
  for (let iter = 0; iter < 60; iter++) {
    const Rt = Rb + BAND / 2;
    const { spans, needSum } = allocate(Rt, usable);
    if (needSum > usable * 0.94) { Rb *= 1.04; continue; }
    let a = -Math.PI / 2, maxOuter = R0;
    segs = content.map((s, i) => {
      const p = pack(nodesFor(s.members), a, spans[i], R0);
      maxOuter = Math.max(maxOuter, p.outer);
      const seg = { ...s, a0: a, a1: a + spans[i], pts: p.pts };
      a += spans[i] + GAP;
      return seg;
    });
    if (maxOuter + 10 > Rb) { Rb = maxOuter + 10; continue; }
    break;
  }
  const band = { ri: Rb, ro: Rb + BAND };
  segs.forEach((s) => { s.mid = Rb + BAND / 2; s.half = (s.a1 - s.a0) / 2; });

  const mR0 = band.ro + 12;
  let ma = -Math.PI / 2 + 0.42, mOuter = mR0;
  const metaSegs = meta.map(([k, c]) => {
    const span = Math.max((labelArc(k, c) + 18) / (mR0 + 20), 0.12);
    const p = pack(nodesFor([[k, c]]), ma, span, mR0);
    mOuter = Math.max(mOuter, p.outer);
    const s = { key: k, count: c, a0: ma, a1: ma + span, pts: p.pts, meta: true };
    ma += span + 0.05;
    return s;
  });
  const metaBand = { ri: mOuter + 4, ro: mOuter + 26 };
  metaSegs.forEach((s) => { s.mid = (metaBand.ri + metaBand.ro) / 2; });
  const orbit = metaBand.ro + 36;
  const n = v.ghosts.length;
  const ghosts = Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + 0.5 + ((TAU - 1) * i) / Math.max(1, n - 1); return { x: Math.cos(a) * orbit, y: Math.sin(a) * orbit }; });
  const smallKeys = new Set(small.map(([k]) => k));
  const dotOf = new Map();
  for (const s of [...segs, ...metaSegs]) for (const p of s.pts) dotOf.set(p.id, p);
  return { segs, band, metaSegs, metaBand, orbit, ghosts, extent: orbit + 30, smallKeys, dotOf, total: v.total };
}
